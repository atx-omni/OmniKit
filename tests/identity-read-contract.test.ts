import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import manageGroupsHandler from '../server/handlers/manage-groups';
import manageUsersHandler from '../server/handlers/manage-users';
import {
  cloneScimUserAttributes,
  findUserByEmail,
  getGroup,
  hasAvailableScimGroupMembershipEvidence,
  listAllGroups,
  listAllUsers,
  parseScimListResponse,
  parseScimGroupMembers,
  SCIM_USER_ATTRIBUTE_LIMITS,
  type ScimListResponse,
} from '../src/services/omniApi';

const BASE_URL = 'https://tenant.example.invalid';
const API_KEY = 'vault-reference-only';
const PRIVATE_MARKER = 'raw-private-response-marker';

test('available list membership evidence avoids a redundant detail read and survives absent detail data', () => {
  const listedMembers = [{ value: 'user-1', display: 'User One' }];
  assert.deepEqual(parseScimGroupMembers(listedMembers), listedMembers);
  assert.equal(hasAvailableScimGroupMembershipEvidence('available', undefined, listedMembers), true);
  assert.equal(hasAvailableScimGroupMembershipEvidence('available', undefined, [{ display: 'Missing ID' }]), false);
  assert.equal(hasAvailableScimGroupMembershipEvidence('failed', undefined, listedMembers), false);
});

function identityHandlerRequest(
  route: 'manage-users' | 'manage-groups',
  body: Record<string, unknown>,
) {
  return new Request(`http://localhost/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'private-api-key-marker',
      ...body,
    }),
  });
}

type CollectionKind = 'user' | 'group';

const collectionContracts = {
  user: {
    endpoint: '/api/manage-users',
    listAll: listAllUsers,
  },
  group: {
    endpoint: '/api/manage-groups',
    listAll: listAllGroups,
  },
} satisfies Record<CollectionKind, {
  endpoint: string;
  listAll: typeof listAllUsers;
}>;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function scimRecord(kind: CollectionKind, id: unknown) {
  return kind === 'user'
    ? { id, userName: `${String(id)}@example.invalid` }
    : { id, displayName: `Group ${String(id)}` };
}

function mockCollectionResponses(
  t: TestContext,
  kind: CollectionKind,
  payloads: unknown[],
  requestedStartIndexes?: number[],
) {
  let responseIndex = 0;
  const starts: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), collectionContracts[kind].endpoint);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.action, 'list');
    starts.push(body.start_index as number);
    if (responseIndex >= payloads.length) throw new Error('Unexpected extra SCIM request in test.');
    return json(payloads[responseIndex++]);
  });
  t.after(() => {
    assert.equal(responseIndex, payloads.length);
    if (requestedStartIndexes) assert.deepEqual(starts, requestedStartIndexes);
  });
}

test('user attributes preserve documented strings, finite numbers, homogeneous arrays, empty arrays, order, and duplicates', async (t) => {
  const attributes = {
    department: 'Architecture',
    quota: 12.5,
    regions: ['Central', 'West', 'Central'],
    thresholds: [2, 1.5, 2],
    unassigned: [],
  };
  mockCollectionResponses(t, 'user', [{
    Resources: [{
      ...scimRecord('user', 'user-supported-attributes'),
      active: false,
      'urn:omni:params:1.0:UserAttribute': attributes,
    }],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
  }], [1]);

  const result = await listAllUsers(BASE_URL, API_KEY);

  assert.equal(result.Resources?.[0]?.active, false);
  assert.deepEqual(result.Resources?.[0]?.['urn:omni:params:1.0:UserAttribute'], attributes);
});

test('user attribute cloning is prototype-safe, structurally exact, and rejects dangerous own keys', () => {
  const source = {
    department: 'Architecture',
    quota: 12.5,
    regions: ['Central', 'West', 'Central'],
    thresholds: [2, 1.5, 2],
    unassigned: [],
  };
  const cloned = cloneScimUserAttributes(source);

  assert.equal(Object.getPrototypeOf(cloned), null);
  assert.deepEqual(Object.entries(cloned), Object.entries(source));
  assert.notEqual(cloned.regions, source.regions);
  assert.notEqual(cloned.thresholds, source.thresholds);

  const dangerous = JSON.parse('{"__proto__":["polluted"],"department":"Architecture"}') as typeof source;
  assert.throws(() => cloneScimUserAttributes(dangerous), /invalid user attributes/i);
  assert.equal(Object.prototype.hasOwnProperty.call(dangerous, '__proto__'), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('user attributes and active state reject unsafe values and every local safety-cap violation', () => {
  const sparse = new Array<string>(2);
  sparse[1] = 'second';
  const oversizedSerialized = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `attribute_${index}`,
      'x'.repeat(SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength),
    ]),
  );
  const invalidResources = [
    { active: 'true' },
    { active: undefined },
    { 'urn:omni:params:1.0:UserAttribute': null },
    { 'urn:omni:params:1.0:UserAttribute': { department: undefined } },
    { 'urn:omni:params:1.0:UserAttribute': { enabled: true } },
    { 'urn:omni:params:1.0:UserAttribute': { department: { value: 'Architecture' } } },
    { 'urn:omni:params:1.0:UserAttribute': { department: [['Architecture']] } },
    { 'urn:omni:params:1.0:UserAttribute': { department: sparse } },
    { 'urn:omni:params:1.0:UserAttribute': { department: ['Architecture', 7] } },
    { 'urn:omni:params:1.0:UserAttribute': { enabled: [true] } },
    { 'urn:omni:params:1.0:UserAttribute': { quota: Number.NaN } },
    { 'urn:omni:params:1.0:UserAttribute': { quota: Number.POSITIVE_INFINITY } },
    { 'urn:omni:params:1.0:UserAttribute': { '   ': 'blank key' } },
    JSON.parse('{"urn:omni:params:1.0:UserAttribute":{"__proto__":"dangerous"}}'),
    JSON.parse('{"urn:omni:params:1.0:UserAttribute":{"ConStructor":"dangerous"}}'),
    JSON.parse('{"urn:omni:params:1.0:UserAttribute":{"PROTOTYPE":"dangerous"}}'),
    { 'urn:omni:params:1.0:UserAttribute': { ' padded': 'leading whitespace' } },
    { 'urn:omni:params:1.0:UserAttribute': { 'padded ': 'trailing whitespace' } },
    { 'urn:omni:params:1.0:UserAttribute': { 'control\u0000key': 'control character' } },
    { 'urn:omni:params:1.0:UserAttribute': { ['k'.repeat(SCIM_USER_ATTRIBUTE_LIMITS.maxKeyLength + 1)]: 'oversized key' } },
    { 'urn:omni:params:1.0:UserAttribute': { note: 'x'.repeat(SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength + 1) } },
    { 'urn:omni:params:1.0:UserAttribute': { regions: Array.from({ length: SCIM_USER_ATTRIBUTE_LIMITS.maxArrayEntries + 1 }, () => 'x') } },
    {
      'urn:omni:params:1.0:UserAttribute': Object.fromEntries(
        Array.from({ length: SCIM_USER_ATTRIBUTE_LIMITS.maxAttributes + 1 }, (_, index) => [`key_${index}`, 'value']),
      ),
    },
    { 'urn:omni:params:1.0:UserAttribute': oversizedSerialized },
  ];
  for (const [index, invalid] of invalidResources.entries()) {
    assert.throws(
      () => parseScimListResponse({
        Resources: [{
          ...scimRecord('user', `user-invalid-attribute-${index}`),
          ...invalid,
          diagnostic: PRIVATE_MARKER,
        }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      }, 'user', 100, 1),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid SCIM user list response/i);
        assert.doesNotMatch(error.message, new RegExp(PRIVATE_MARKER, 'i'));
        return true;
      },
    );
  }
});

test('SCIM collection rejects an own error property even when the value is falsy or null', async (t) => {
  const payloads = ['', false, null].map((error) => ({
    Resources: [],
    totalResults: 0,
    startIndex: 1,
    itemsPerPage: 0,
    error,
  }));
  mockCollectionResponses(t, 'user', payloads);

  for (const payload of payloads) {
    void payload;
    await assert.rejects(
      listAllUsers(BASE_URL, API_KEY),
      /SCIM user list request/i,
    );
  }
});

async function rejectsWithoutRawValues(promise: Promise<unknown>, kind: CollectionKind) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`invalid SCIM ${kind} list response`, 'i'));
    assert.doesNotMatch(error.message, new RegExp(PRIVATE_MARKER, 'i'));
    return true;
  });
}

for (const kind of ['user', 'group'] as const) {
  test(`${kind} collection preserves a legitimate complete empty SCIM response`, async (t) => {
    mockCollectionResponses(t, kind, [{
      Resources: [],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
    }], [1]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY);

    assert.deepEqual(result.Resources, []);
    assert.equal(result.totalResults, 0);
    assert.equal(result.loadedResults, 0);
    assert.equal(result.truncated, false);
  });

  test(`${kind} collection rejects a successful response with missing Resources`, async (t) => {
    mockCollectionResponses(t, kind, [{
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      diagnostic: PRIVATE_MARKER,
    }]);

    await rejectsWithoutRawValues(
      collectionContracts[kind].listAll(BASE_URL, API_KEY),
      kind,
    );
  });

  test(`${kind} collection rejects explicit service errors without exposing response values`, async (t) => {
    mockCollectionResponses(t, kind, [{ error: PRIVATE_MARKER }]);

    await assert.rejects(
      collectionContracts[kind].listAll(BASE_URL, API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`SCIM ${kind} list request`, 'i'));
        assert.doesNotMatch(error.message, new RegExp(PRIVATE_MARKER, 'i'));
        return true;
      },
    );
  });

  test(`${kind} collection rejects missing, mistyped, or inconsistent pagination metadata`, async (t) => {
    const invalidResponses = [
      { Resources: [], totalResults: '0', startIndex: 1, itemsPerPage: 0 },
      { Resources: [], totalResults: -1, startIndex: 1, itemsPerPage: 0 },
      { Resources: [], totalResults: 0, itemsPerPage: 0 },
      { Resources: [], totalResults: 0, startIndex: 2, itemsPerPage: 0 },
      { Resources: [], totalResults: 0, startIndex: 1 },
      { Resources: [], totalResults: 0, startIndex: 1, itemsPerPage: 1 },
      { Resources: [], totalResults: 2, startIndex: 1, itemsPerPage: 0 },
    ];
    mockCollectionResponses(t, kind, invalidResponses);

    for (const payload of invalidResponses) {
      void payload;
      await rejectsWithoutRawValues(
        collectionContracts[kind].listAll(BASE_URL, API_KEY),
        kind,
      );
    }
  });

  test(`${kind} collection rejects malformed records and missing required identity fields`, async (t) => {
    const invalidResponses = [
      {
        Resources: [null],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        diagnostic: PRIVATE_MARKER,
      },
      {
        Resources: [{ ...scimRecord(kind, 7), diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        Resources: [{ ...scimRecord(kind, '   '), diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        Resources: [{ id: `${kind}-missing-required-name`, diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      },
      ...(kind === 'group' ? [{
        Resources: [{ ...scimRecord('group', 'group-invalid-members'), members: [{}], diagnostic: PRIVATE_MARKER }],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
      }] : []),
      ...(kind === 'user' ? [
        {
          Resources: [{ ...scimRecord('user', 'user-bad-display'), displayName: {} }],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
        },
        {
          Resources: [{ ...scimRecord('user', 'user-bad-groups'), groups: [null] }],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
        },
        {
          Resources: [{
            ...scimRecord('user', 'user-bad-attributes'),
            'urn:omni:params:1.0:UserAttribute': { department: {} },
          }],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
        },
      ] : []),
    ];
    mockCollectionResponses(t, kind, invalidResponses);

    for (const payload of invalidResponses) {
      void payload;
      await rejectsWithoutRawValues(
        collectionContracts[kind].listAll(BASE_URL, API_KEY),
        kind,
      );
    }
  });

  test(`${kind} collection advances by verified page evidence and completes exactly`, async (t) => {
    mockCollectionResponses(t, kind, [
      {
        Resources: [scimRecord(kind, `${kind}-1`)],
        totalResults: 3,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        Resources: [scimRecord(kind, `${kind}-2`), scimRecord(kind, `${kind}-3`)],
        totalResults: 3,
        startIndex: 2,
        itemsPerPage: 2,
      },
    ], [1, 2]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY, {
      pageSize: 3,
      maxPages: 2,
    });

    assert.deepEqual(result.Resources?.map((resource) => resource.id), [
      `${kind}-1`,
      `${kind}-2`,
      `${kind}-3`,
    ]);
    assert.equal(result.totalResults, 3);
    assert.equal(result.loadedResults, 3);
    assert.equal(result.truncated, false);
  });

  test(`${kind} collection reports a page-cap truncation explicitly`, async (t) => {
    mockCollectionResponses(t, kind, [{
      Resources: [scimRecord(kind, `${kind}-1`)],
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 1,
    }], [1]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY, {
      pageSize: 3,
      maxPages: 1,
    });

    assert.equal(result.loadedResults, 1);
    assert.equal(result.totalResults, 3);
    assert.equal(result.truncated, true);
  });

  test(`${kind} collection preserves verified earlier pages when a later page is invalid`, async (t) => {
    mockCollectionResponses(t, kind, [
      {
        Resources: [scimRecord(kind, `${kind}-1`)],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 1,
      },
      {
        totalResults: 2,
        startIndex: 2,
        itemsPerPage: 1,
        diagnostic: PRIVATE_MARKER,
      },
    ], [1, 2]);

    const result = await collectionContracts[kind].listAll(BASE_URL, API_KEY, {
      pageSize: 2,
      maxPages: 2,
    });

    assert.deepEqual(result.Resources?.map((resource) => resource.id), [`${kind}-1`]);
    assert.equal(result.totalResults, 2);
    assert.equal(result.loadedResults, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.error, 'partial_collection_read_failed');
    assert.equal(JSON.stringify(result).includes(PRIVATE_MARKER), false);
  });

  test(`${kind} collection rejects repeated records or changing totals across pages`, async (t) => {
    mockCollectionResponses(t, kind, [
      {
        Resources: [scimRecord(kind, `${kind}-1`), scimRecord(kind, `${kind}-2`)],
        totalResults: 4,
        startIndex: 1,
        itemsPerPage: 2,
      },
      {
        Resources: [scimRecord(kind, `${kind}-2`), scimRecord(kind, `${kind}-3`)],
        totalResults: 4,
        startIndex: 3,
        itemsPerPage: 2,
      },
    ], [1, 3]);

    await rejectsWithoutRawValues(
      collectionContracts[kind].listAll(BASE_URL, API_KEY, { pageSize: 2, maxPages: 2 }),
      kind,
    );
  });
}

test('filtered user lookup requires an exact normalized identity match', async (t) => {
  const responses = [
    {
      Resources: [{ id: 'user-incomplete', userName: 'person@example.invalid' }],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 1,
    },
    {
      Resources: [{ id: 'user-wrong', userName: 'different@example.invalid' }],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    },
    {
      Resources: [{ id: 'user-exact', userName: 'Person@Example.Invalid' }],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), '/api/manage-users');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.action, 'find');
    return json(responses[responseIndex++]);
  });

  await assert.rejects(
    findUserByEmail(BASE_URL, API_KEY, 'person@example.invalid'),
    /invalid SCIM user list response/i,
  );
  await assert.rejects(
    findUserByEmail(BASE_URL, API_KEY, 'person@example.invalid'),
    /invalid SCIM user list response/i,
  );
  const exact = await findUserByEmail(BASE_URL, API_KEY, ' person@example.invalid ');
  assert.equal(exact.Resources?.[0]?.id, 'user-exact');
  assert.equal(responseIndex, 3);
});

test('group detail rejects mismatched identity and malformed membership records', async (t) => {
  const responses = [
    { id: 'different-group', displayName: 'Different', members: [] },
    { id: 'group-1', displayName: 'Group 1', members: [{}] },
    { id: 'group-1', displayName: 'Group 1', members: [{ value: 'user-1', display: 'person@example.invalid' }] },
  ];
  let responseIndex = 0;
  t.mock.method(globalThis, 'fetch', async () => json(responses[responseIndex++]));

  await assert.rejects(getGroup(BASE_URL, API_KEY, 'group-1'), /invalid SCIM group list response/i);
  await assert.rejects(getGroup(BASE_URL, API_KEY, 'group-1'), /invalid SCIM group list response/i);
  const group = await getGroup(BASE_URL, API_KEY, 'group-1');
  assert.equal(group.members?.[0]?.value, 'user-1');
  assert.equal(responseIndex, 3);
});

test('changing totals across pages fail instead of completing a mixed snapshot', async (t) => {
  mockCollectionResponses(t, 'user', [
    {
      Resources: [scimRecord('user', 'user-1'), scimRecord('user', 'user-2')],
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 2,
    },
    {
      Resources: [scimRecord('user', 'user-3'), scimRecord('user', 'user-4')],
      totalResults: 4,
      startIndex: 3,
      itemsPerPage: 2,
    },
  ], [1, 3]);

  await rejectsWithoutRawValues(
    listAllUsers(BASE_URL, API_KEY, { pageSize: 2, maxPages: 2 }),
    'user',
  );
});

test('invalid local pagination options fail before any request', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return json({});
  });

  await assert.rejects(
    listAllGroups(BASE_URL, API_KEY, { pageSize: 0, maxPages: 1 }),
    /Invalid SCIM pagination configuration/,
  );
  await assert.rejects(
    listAllUsers(BASE_URL, API_KEY, { pageSize: 100, maxPages: 0 }),
    /Invalid SCIM pagination configuration/,
  );
  assert.equal(fetchCount, 0);
});

test('identity handlers encode opaque path IDs and never forward upstream error bodies', async (t) => {
  const requestedUrls: string[] = [];
  let responseIndex = 0;
  const privateUpstreamBody = `private-person@example.invalid ${PRIVATE_MARKER}`;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    responseIndex += 1;
    if (responseIndex <= 2) return new Response(null, { status: 204 });
    return new Response(privateUpstreamBody, {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });
  });

  const userId = 'user/../private?role=admin#fragment';
  const groupId = 'group/../private?role=admin#fragment';
  const updatedUser = await manageUsersHandler(identityHandlerRequest('manage-users', {
    action: 'update',
    user_id: userId,
    user_data: { displayName: 'Safe name' },
  }));
  const updatedGroup = await manageGroupsHandler(identityHandlerRequest('manage-groups', {
    action: 'patch',
    group_id: groupId,
    group_data: { Operations: [] },
  }));
  const failedUsers = await manageUsersHandler(identityHandlerRequest('manage-users', { action: 'list' }));
  const failedGroups = await manageGroupsHandler(identityHandlerRequest('manage-groups', { action: 'list' }));

  assert.equal(updatedUser.status, 200);
  assert.equal(updatedGroup.status, 200);
  assert.match(requestedUrls[0], /\/api\/scim\/v2\/users\/user%2F\.\.%2Fprivate%3Frole%3Dadmin%23fragment$/);
  assert.match(requestedUrls[1], /\/api\/scim\/v2\/groups\/group%2F\.\.%2Fprivate%3Frole%3Dadmin%23fragment$/);

  for (const response of [failedUsers, failedGroups]) {
    assert.equal(response.status, 403);
    const serialized = await response.text();
    assert.doesNotMatch(serialized, /private-person@example\.invalid/i);
    assert.doesNotMatch(serialized, new RegExp(PRIVATE_MARKER, 'i'));
    assert.doesNotMatch(serialized, /private-api-key-marker/i);
    assert.match(serialized, /failed with HTTP 403/i);
  }
  assert.equal(responseIndex, 4);
});

// Compile-time guard: aggregated list reads retain their documented response type.
const _responseContract: ScimListResponse = {
  Resources: [],
  totalResults: 0,
  startIndex: 1,
  itemsPerPage: 0,
  loadedResults: 0,
  truncated: false,
};
void _responseContract;

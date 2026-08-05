import assert from 'node:assert/strict';
import test from 'node:test';

import manageGroups from '../server/handlers/manage-groups';
import manageUsers from '../server/handlers/manage-users';
import {
  buildGroupMembershipPatch,
  parseIdentityImportCsv,
} from '../src/services/userManagement/bulkIdentityImport';

test('unified identity CSV supports quoted values, CRLF, and explicit attribute columns', () => {
  const plan = parseIdentityImportCsv([
    'record_type,action,email,display_name,group_name,attribute_department',
    'user,upsert,casey@example.com,"Doe, Casey",,Analytics',
    'group,ensure,,,"Analytics, Central",',
    'membership,add,casey@example.com,,"Analytics, Central",',
  ].join('\r\n'));

  assert.equal(plan.format, 'unified');
  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.deepEqual(plan.summary, {
    userUpserts: 1,
    userDeletes: 0,
    groupsEnsured: 1,
    membershipsAdded: 1,
    membershipsRemoved: 0,
  });
  assert.deepEqual(plan.records[0], {
    type: 'user',
    action: 'upsert',
    rowNumber: 2,
    email: 'casey@example.com',
    displayName: 'Doe, Casey',
    attributes: { department: 'Analytics' },
  });
});

test('unified identity CSV preserves multiline quoted display names', () => {
  const plan = parseIdentityImportCsv([
    'record_type,action,email,display_name,group_name',
    'user,upsert,casey@example.com,"Casey\nDoe",',
  ].join('\n'));

  assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(plan.records[0].type, 'user');
  if (plan.records[0].type === 'user') assert.equal(plan.records[0].displayName, 'Casey\nDoe');
});

test('legacy user and membership templates remain importable', () => {
  const users = parseIdentityImportCsv([
    'email,display_name,op,department',
    'analyst@example.com,Example Analyst,upsert,Finance',
  ].join('\n'));
  const memberships = parseIdentityImportCsv([
    'email,group_name,op',
    'analyst@example.com,Finance Users,add',
  ].join('\n'));

  assert.equal(users.format, 'legacy-users');
  assert.deepEqual(users.records[0], {
    type: 'user',
    action: 'upsert',
    rowNumber: 2,
    email: 'analyst@example.com',
    displayName: 'Example Analyst',
    attributes: { department: 'Finance' },
  });
  assert.equal(memberships.format, 'legacy-memberships');
  assert.equal(memberships.records[0].type, 'membership');
});

test('conflicting operations block an identity import while exact duplicates are ignored', () => {
  const plan = parseIdentityImportCsv([
    'record_type,action,email,display_name,group_name',
    'membership,add,analyst@example.com,,Finance Users',
    'membership,add,analyst@example.com,,Finance Users',
    'membership,remove,analyst@example.com,,Finance Users',
  ].join('\n'));

  assert.equal(plan.records.length, 1);
  assert.match(plan.issues.find((issue) => issue.severity === 'warning')?.message || '', /Duplicate membership add/);
  assert.match(plan.issues.find((issue) => issue.severity === 'error')?.message || '', /Conflicting membership actions/);
});

test('group membership patches batch additions and targeted removals without replacing unrelated members', () => {
  const patch = buildGroupMembershipPatch(
    [{ value: 'user-new', display: 'new@example.com' }],
    ['user-old'],
  );

  assert.deepEqual(patch, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [
      { op: 'add', path: 'members', value: [{ value: 'user-new', display: 'new@example.com' }] },
      { op: 'remove', path: 'members[value eq "user-old"]' },
    ],
  });
});

function groupRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/manage-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'test-vault-reference',
      ...body,
    }),
  });
}

test('group handler creates groups through the SCIM v2 endpoint', async (t) => {
  let requestMethod = '';
  let requestUrl = '';
  let requestBody: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestMethod = init?.method || '';
    requestBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ id: 'group-1', displayName: 'Finance Users', members: [] }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await manageGroups(groupRequest({
    action: 'create',
    group_data: { displayName: 'Finance Users', members: [] },
  }));

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'POST');
  assert.equal(new URL(requestUrl).pathname, '/api/scim/v2/groups');
  assert.deepEqual(requestBody, { displayName: 'Finance Users', members: [] });
});

test('group handler applies SCIM patch operations instead of replacing the group', async (t) => {
  let requestMethod = '';
  let requestBody: unknown;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    requestMethod = init?.method || '';
    requestBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({ id: 'group-1', displayName: 'Finance Users', members: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const patch = buildGroupMembershipPatch([{ value: 'user-1' }], []);

  const response = await manageGroups(groupRequest({ action: 'patch', group_id: 'group-1', group_data: patch }));

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'PATCH');
  assert.deepEqual(requestBody, patch);
});

test('user attribute preflight uses the documented attribute inventory endpoint', async (t) => {
  let requestMethod = '';
  let requestUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestMethod = init?.method || '';
    return new Response(JSON.stringify({ userAttributes: [{ name: 'department' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const response = await manageUsers(new Request('http://localhost/api/manage-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      api_key: 'test-vault-reference',
      action: 'list_attributes',
    }),
  }));

  assert.equal(response.status, 200);
  assert.equal(requestMethod, 'GET');
  assert.equal(new URL(requestUrl).pathname, '/api/v1/user-attributes');
});

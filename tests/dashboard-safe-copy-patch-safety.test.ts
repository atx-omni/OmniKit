import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateAdditiveDashboardSafeCopyPatches,
  type DashboardSafeCopyPatchCandidate,
  type DashboardSafeCopyPatchSafetyExceptionCode,
} from '../server/services/dashboardSafeCopyPatchSafety';

function patch(overrides: Partial<DashboardSafeCopyPatchCandidate> = {}): DashboardSafeCopyPatchCandidate {
  return {
    id: 'field:orders.view:orders.new_field',
    artifactType: 'field',
    targetFileName: 'orders.view',
    resolution: 'recommended',
    acceptedYaml: [
      'dimensions:',
      '  - name: existing_field',
      '    sql: ${TABLE}.existing_field',
      '  - name: new_field',
      '    sql: ${TABLE}.new_field',
      'metadata:',
      '  owner: analytics',
      '  certified: true',
    ].join('\n'),
    previousChecksum: 'checksum-current',
    latestChecksum: 'checksum-current',
    status: 'ready',
    safetyCategory: 'safe_update',
    ...overrides,
  };
}

const currentFiles = {
  'orders.view': {
    yaml: [
      'dimensions:',
      '  - name: existing_field',
      '    sql: ${TABLE}.existing_field',
      'metadata:',
      '  owner: analytics',
    ].join('\n'),
    checksum: 'checksum-current',
  },
};

function exceptionCodes(result: ReturnType<typeof validateAdditiveDashboardSafeCopyPatches>) {
  return result.exceptions.map((exception) => exception.code);
}

function expectCodes(
  result: ReturnType<typeof validateAdditiveDashboardSafeCopyPatches>,
  expected: DashboardSafeCopyPatchSafetyExceptionCode[],
): void {
  assert.equal(result.status, 'rejected');
  assert.deepEqual(exceptionCodes(result), expected);
}

test('safe create and monotonic safe update pass without returning YAML', () => {
  const updateResult = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch()],
    currentFiles,
  });
  assert.equal(updateResult.status, 'passed');
  assert.deepEqual(updateResult.evidence, [{
    patchId: 'field:orders.view:orders.new_field',
    artifactType: 'field',
    targetFileName: 'orders.view',
    operation: 'update',
    status: 'passed',
    acceptedYaml: 'verified',
    checksum: 'verified',
    monotonicity: 'verified',
    exceptionCodes: [],
  }]);

  const createResult = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      id: 'topic:new.topic',
      artifactType: 'topic',
      targetFileName: 'new.topic',
      safetyCategory: 'safe_create',
      previousChecksum: undefined,
      latestChecksum: undefined,
      acceptedYaml: 'label: New topic\nviews:\n  orders: {}',
    })],
    currentFiles,
  });
  assert.equal(createResult.status, 'passed');
  assert.equal(createResult.evidence[0].operation, 'create');
  assert.equal(createResult.evidence[0].checksum, 'not_applicable');
  assert.doesNotMatch(JSON.stringify({ updateResult, createResult }), /\$\{TABLE\}|analytics|certified|New topic/);
});

test('object, scalar, and list removal or replacement is rejected', () => {
  const candidates = [
    patch({
      id: 'delete-object-key',
      acceptedYaml: 'dimensions:\n  - name: existing_field\n    sql: ${TABLE}.existing_field',
    }),
    patch({
      id: 'replace-scalar',
      acceptedYaml: 'dimensions:\n  - name: existing_field\n    sql: ${TABLE}.changed\nmetadata:\n  owner: analytics',
    }),
    patch({
      id: 'delete-list-entry',
      acceptedYaml: 'dimensions: []\nmetadata:\n  owner: analytics',
    }),
  ];

  for (const candidate of candidates) {
    const result = validateAdditiveDashboardSafeCopyPatches({ patches: [candidate], currentFiles });
    expectCodes(result, ['SAFE_COPY_PATCH_NON_MONOTONIC']);
  }
});

test('existing list order is preserved while additive entries may be interleaved', () => {
  const files = {
    relationships: {
      yaml: '- name: first\n  value: 1\n- name: second\n  value: 2',
      checksum: 'relationships-checksum',
    },
  };
  const additive = patch({
    id: 'relationship-additive',
    artifactType: 'relationship',
    targetFileName: 'relationships',
    previousChecksum: 'relationships-checksum',
    latestChecksum: 'relationships-checksum',
    acceptedYaml: '- name: first\n  value: 1\n- name: inserted\n  value: 3\n- name: second\n  value: 2',
  });
  assert.equal(validateAdditiveDashboardSafeCopyPatches({ patches: [additive], currentFiles: files }).status, 'passed');

  const reordered = patch({
    ...additive,
    id: 'relationship-reordered',
    acceptedYaml: '- name: second\n  value: 2\n- name: first\n  value: 1',
  });
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({ patches: [reordered], currentFiles: files }),
    ['SAFE_COPY_PATCH_NON_MONOTONIC'],
  );
});

test('existing writes require an exact current and previous checksum', () => {
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch({ previousChecksum: undefined })],
      currentFiles,
    }),
    ['SAFE_COPY_PATCH_PREVIOUS_CHECKSUM_MISSING'],
  );
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch({ previousChecksum: 'old-checksum' })],
      currentFiles,
    }),
    ['SAFE_COPY_PATCH_CHECKSUM_MISMATCH'],
  );
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch({ checksumStale: true })],
      currentFiles,
    }),
    ['SAFE_COPY_PATCH_STALE_CHECKSUM'],
  );
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch()],
      currentFiles: { 'orders.view': { yaml: currentFiles['orders.view'].yaml } },
    }),
    ['SAFE_COPY_PATCH_CURRENT_CHECKSUM_MISSING'],
  );
});

test('permission, protected, blocked, manual, destructive, and non-server-owned patches fail closed', () => {
  const cases: Array<{
    candidate: DashboardSafeCopyPatchCandidate;
    protectedTarget?: boolean;
    code: DashboardSafeCopyPatchSafetyExceptionCode;
  }> = [
    { candidate: patch({ artifactType: 'permission' }), code: 'SAFE_COPY_PATCH_PERMISSION_FORBIDDEN' },
    { candidate: patch(), protectedTarget: true, code: 'SAFE_COPY_PATCH_TARGET_PROTECTED' },
    { candidate: patch({ status: 'blocked' }), code: 'SAFE_COPY_PATCH_BLOCKED' },
    { candidate: patch({ safetyCategory: 'manual_review' }), code: 'SAFE_COPY_PATCH_MANUAL_REVIEW' },
    { candidate: patch({ destructive: true }), code: 'SAFE_COPY_PATCH_DESTRUCTIVE' },
    { candidate: patch({ resolution: 'use_source' }), code: 'SAFE_COPY_PATCH_RESOLUTION_FORBIDDEN' },
    { candidate: patch({ safetyCategory: undefined }), code: 'SAFE_COPY_PATCH_SAFETY_CATEGORY_FORBIDDEN' },
  ];

  for (const row of cases) {
    const result = validateAdditiveDashboardSafeCopyPatches({
      patches: [row.candidate],
      currentFiles,
      protectedTarget: row.protectedTarget,
    });
    assert.equal(result.status, 'rejected');
    assert.ok(exceptionCodes(result).includes(row.code));
  }
});

test('keep_target passes without accepted YAML or checksum but cannot bypass safety policy', () => {
  const kept = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      resolution: 'keep_target',
      acceptedYaml: undefined,
      previousChecksum: undefined,
      latestChecksum: undefined,
      safetyCategory: 'safe_ignore',
    })],
    currentFiles,
  });
  assert.equal(kept.status, 'passed');
  assert.equal(kept.evidence[0].operation, 'keep_target');
  assert.equal(kept.evidence[0].acceptedYaml, 'not_applicable');

  const forbidden = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      artifactType: 'permission',
      resolution: 'keep_target',
      acceptedYaml: undefined,
      safetyCategory: 'safe_ignore',
    })],
    currentFiles,
  });
  expectCodes(forbidden, ['SAFE_COPY_PATCH_PERMISSION_FORBIDDEN']);
});

test('missing, malformed, scalar-only, and invalid current YAML fail with fixed evidence only', () => {
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({ patches: [patch({ acceptedYaml: undefined })], currentFiles }),
    ['SAFE_COPY_PATCH_ACCEPTED_YAML_MISSING'],
  );
  const malformed = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({ acceptedYaml: 'secret_value: [unterminated' })],
    currentFiles,
  });
  expectCodes(malformed, ['SAFE_COPY_PATCH_ACCEPTED_YAML_INVALID']);
  assert.doesNotMatch(JSON.stringify(malformed), /secret_value|unterminated/);

  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({ patches: [patch({ acceptedYaml: 'scalar only' })], currentFiles }),
    ['SAFE_COPY_PATCH_ACCEPTED_YAML_INCOMPLETE'],
  );
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch()],
      currentFiles: { 'orders.view': { yaml: 'secret_current: [unterminated', checksum: 'checksum-current' } },
    }),
    ['SAFE_COPY_PATCH_CURRENT_YAML_INVALID'],
  );
});

test('create collisions, missing update targets, and duplicate target-file decisions are rejected', () => {
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch({ safetyCategory: 'safe_create' })],
      currentFiles,
    }),
    ['SAFE_COPY_PATCH_CREATE_COLLISION'],
  );
  expectCodes(
    validateAdditiveDashboardSafeCopyPatches({
      patches: [patch({ targetFileName: 'missing.view', previousChecksum: undefined, latestChecksum: undefined })],
      currentFiles,
    }),
    ['SAFE_COPY_PATCH_UPDATE_TARGET_MISSING'],
  );

  const duplicate = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({ id: 'first' }), patch({ id: 'second' })],
    currentFiles,
  });
  assert.equal(duplicate.status, 'rejected');
  assert.deepEqual(exceptionCodes(duplicate), [
    'SAFE_COPY_PATCH_DUPLICATE_TARGET_FILE',
    'SAFE_COPY_PATCH_DUPLICATE_TARGET_FILE',
  ]);

  const duplicateId = validateAdditiveDashboardSafeCopyPatches({
    patches: [
      patch({ id: 'duplicate-id', targetFileName: 'first.view', safetyCategory: 'safe_create', previousChecksum: undefined, latestChecksum: undefined }),
      patch({ id: 'duplicate-id', targetFileName: 'second.view', safetyCategory: 'safe_create', previousChecksum: undefined, latestChecksum: undefined }),
    ],
    currentFiles: {},
  });
  assert.equal(duplicateId.status, 'rejected');
  assert.deepEqual(exceptionCodes(duplicateId), [
    'SAFE_COPY_PATCH_DUPLICATE_ID',
    'SAFE_COPY_PATCH_DUPLICATE_ID',
  ]);

  const ambiguousCurrentFile = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch()],
    currentFiles: {
      'orders.view': currentFiles['orders.view'],
      'ORDERS.VIEW': currentFiles['orders.view'],
    },
  });
  assert.ok(exceptionCodes(ambiguousCurrentFile).includes('SAFE_COPY_PATCH_CURRENT_FILE_AMBIGUOUS'));
});

test('permission keys and advanced YAML syntax fail closed regardless of patch label', () => {
  const disguisedPermission = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      acceptedYaml: [
        'dimensions:',
        '  - name: existing_field',
        '    sql: ${TABLE}.existing_field',
        '    required_access_grants: finance_team',
        'metadata:',
        '  owner: analytics',
      ].join('\n'),
    })],
    currentFiles,
  });
  assert.ok(exceptionCodes(disguisedPermission).includes('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN'));

  const pluralUserAttributes = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      id: 'plural-user-attributes',
      targetFileName: 'new.view',
      acceptedYaml: 'user_attributes:\n  region:\n    type: string',
      safetyCategory: 'safe_create',
      previousChecksum: undefined,
      latestChecksum: undefined,
    })],
    currentFiles: {},
  });
  assert.ok(exceptionCodes(pluralUserAttributes).includes('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN'));

  const scalarReferenceCreate = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      id: 'scalar-reference-create',
      targetFileName: 'new.view',
      acceptedYaml: 'dimensions:\n  region:\n    sql: "{{ omni_attributes.region }}"',
      safetyCategory: 'safe_create',
      previousChecksum: undefined,
      latestChecksum: undefined,
    })],
    currentFiles: {},
  });
  assert.ok(exceptionCodes(scalarReferenceCreate).includes('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN'));

  const scalarReferenceUpdate = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      acceptedYaml: [
        'dimensions:',
        '  - name: existing_field',
        '    sql: ${TABLE}.existing_field',
        '  - name: region',
        '    sql: "{{ omni_attributes.region }}"',
        'metadata:',
        '  owner: analytics',
      ].join('\n'),
    })],
    currentFiles,
  });
  assert.ok(exceptionCodes(scalarReferenceUpdate).includes('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN'));

  const scalarReferenceCurrent = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      acceptedYaml: 'dimensions:\n  - name: existing_field\n    sql: "{{ omni_attributes.region }}"\nmetadata:\n  owner: analytics',
    })],
    currentFiles: {
      'orders.view': {
        yaml: 'dimensions:\n  - name: existing_field\n    sql: "{{ omni_attributes.region }}"\nmetadata:\n  owner: analytics',
        checksum: 'checksum-current',
      },
    },
  });
  assert.ok(exceptionCodes(scalarReferenceCurrent).includes('SAFE_COPY_PATCH_PERMISSION_CONTENT_FORBIDDEN'));

  const anchoredCurrent = {
    'orders.view': {
      yaml: 'defaults: &defaults\n  role: viewer\ntarget:\n  <<: *defaults',
      checksum: 'checksum-current',
    },
  };
  const mergeOverride = validateAdditiveDashboardSafeCopyPatches({
    patches: [patch({
      acceptedYaml: 'defaults: &defaults\n  role: viewer\ntarget:\n  <<: *defaults\n  role: admin',
    })],
    currentFiles: anchoredCurrent,
  });
  assert.equal(mergeOverride.status, 'rejected');
  assert.ok(exceptionCodes(mergeOverride).includes('SAFE_COPY_PATCH_ACCEPTED_YAML_INVALID'));
  assert.ok(exceptionCodes(mergeOverride).includes('SAFE_COPY_PATCH_CURRENT_YAML_INVALID'));
});

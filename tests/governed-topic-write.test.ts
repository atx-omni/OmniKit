import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stageGovernedTopicMutation,
  type GovernedTopicWriteApi,
  type ReviewedModelBranch,
} from '../src/services/reviewedModelWrite';
import { ApiError } from '../src/services/omniApi';

const connection = {
  baseUrl: 'https://example.omniapp.co',
  apiKey: 'vault-reference',
  status: 'success' as const,
  errorMessage: '',
};

function reviewedBranch(overrides: Partial<ReviewedModelBranch> = {}): ReviewedModelBranch {
  return {
    modelId: 'model-1',
    branchId: 'branch-1',
    branchName: 'review-topic-change',
    capability: {
      editable: true,
      gitConfigured: false,
      gitConfigurationKnown: true,
      gitFollower: false,
      pullRequestRequired: false,
    },
    ...overrides,
  };
}

function mockApi(overrides: Partial<GovernedTopicWriteApi> = {}): GovernedTopicWriteApi {
  return {
    getModelYaml: async () => ({ files: {}, checksums: {} }),
    updateModelYamlFile: async () => ({ success: true }),
    deleteModelYamlFile: async () => ({ success: true }),
    validateModel: async () => [],
    validateModelContent: async () => ({ content: [] }),
    ...overrides,
  };
}

test('governed topic mutations require an existing reviewed branch', async () => {
  let fetchCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return { files: {}, checksums: {} };
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch({ branchId: '' }), {
      action: 'create',
      fileName: 'example_topic.topic',
      yaml: 'base_view: example_view\n',
    }, api),
    /existing reviewed model branch/i,
  );
  assert.equal(fetchCount, 0);
});

test('governed topic create stages a complete topic file on the branch and returns review evidence', async () => {
  const requestedYaml = 'base_view: example_view\nlabel: Example Topic\n';
  let fetchCount = 0;
  let updateParams: Parameters<GovernedTopicWriteApi['updateModelYamlFile']>[2] | undefined;
  let modelValidationCount = 0;
  let contentValidationCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: {}, checksums: {} }
        : { files: { 'example_topic.topic': requestedYaml }, checksums: { 'example_topic.topic': 'checksum-created' } };
    },
    updateModelYamlFile: async (_baseUrl, _apiKey, params) => {
      updateParams = params;
      return { fileName: params.fileName, success: true };
    },
    validateModel: async () => {
      modelValidationCount += 1;
      return [];
    },
    validateModelContent: async () => {
      contentValidationCount += 1;
      return { content: [] };
    },
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'create',
    fileName: 'example_topic.topic',
    yaml: requestedYaml,
  }, api);

  assert.equal(fetchCount, 2);
  assert.equal(updateParams?.modelId, 'model-1');
  assert.equal(updateParams?.branchId, 'branch-1');
  assert.equal(updateParams?.fileName, 'example_topic.topic');
  assert.equal(updateParams?.yaml, requestedYaml);
  assert.equal(updateParams?.previousChecksum, undefined);
  assert.equal(updateParams?.fullyResolved, false);
  assert.equal(modelValidationCount, 1);
  assert.equal(contentValidationCount, 1);
  assert.equal(evidence.status, 'review_ready');
  assert.equal(evidence.before.exists, false);
  assert.equal(evidence.after.checksum, 'checksum-created');
  assert.deepEqual(evidence.diff, {
    fileName: 'example_topic.topic',
    beforeYaml: '',
    afterYaml: requestedYaml,
    changed: true,
  });
  assert.equal(evidence.requiresHumanReview, true);
  assert.equal(evidence.published, false);
});

test('governed topic update passes the fetched checksum with the full replacement YAML', async () => {
  const beforeYaml = 'base_view: example_view\nlabel: Old Label\n';
  const afterYaml = 'base_view: example_view\nlabel: New Label\n';
  let fetchCount = 0;
  let updateParams: Parameters<GovernedTopicWriteApi['updateModelYamlFile']>[2] | undefined;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: { 'example_topic.topic': beforeYaml }, checksums: { 'example_topic.topic': 'checksum-before' } }
        : { files: { 'example_topic.topic': afterYaml }, checksums: { 'example_topic.topic': 'checksum-after' } };
    },
    updateModelYamlFile: async (_baseUrl, _apiKey, params) => {
      updateParams = params;
      return { fileName: params.fileName, success: true };
    },
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'update',
    fileName: 'example_topic.topic',
    yaml: afterYaml,
    commitMessage: 'Stage reviewed topic update',
  }, api);

  assert.equal(updateParams?.previousChecksum, 'checksum-before');
  assert.equal(updateParams?.yaml, afterYaml);
  assert.equal(updateParams?.commitMessage, 'Stage reviewed topic update');
  assert.equal(evidence.before.yaml, beforeYaml);
  assert.equal(evidence.after.yaml, afterYaml);
  assert.equal(evidence.after.checksum, 'checksum-after');
  assert.equal(evidence.diff.beforeYaml, beforeYaml);
  assert.equal(evidence.diff.afterYaml, afterYaml);
});

test('governed topic update blocks when Omni does not return a checksum', async () => {
  let updateCount = 0;
  const api = mockApi({
    getModelYaml: async () => ({
      files: { 'example_topic.topic': 'base_view: example_view\n' },
      checksums: {},
    }),
    updateModelYamlFile: async () => {
      updateCount += 1;
      return { success: true };
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'update',
      fileName: 'example_topic.topic',
      yaml: 'base_view: example_view\nlabel: Updated\n',
    }, api),
    /did not return a checksum/i,
  );
  assert.equal(updateCount, 0);
});

test('governed topic update rejects a stale expected checksum before issuing a write', async () => {
  const currentYaml = 'base_view: example_view\nlabel: Current Label\n';
  let fetchCount = 0;
  let updateCount = 0;
  let deleteCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return {
        files: { 'example_topic.topic': currentYaml },
        checksums: { 'example_topic.topic': 'checksum-current' },
      };
    },
    updateModelYamlFile: async () => {
      updateCount += 1;
      return { success: true };
    },
    deleteModelYamlFile: async () => {
      deleteCount += 1;
      return { success: true };
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'update',
      fileName: 'example_topic.topic',
      yaml: 'base_view: example_view\nlabel: Intended Label\n',
      expectedPreWriteSnapshot: {
        exists: true,
        checksum: 'checksum-loaded-earlier',
        yaml: currentYaml,
      },
    }, api),
    /stale or concurrent edit.*refresh/i,
  );
  assert.equal(fetchCount, 1);
  assert.equal(updateCount, 0);
  assert.equal(deleteCount, 0);
});

test('governed topic update rejects stale expected YAML even when the checksum matches', async () => {
  let updateCount = 0;
  const api = mockApi({
    getModelYaml: async () => ({
      files: { 'example_topic.topic': 'base_view: example_view\nlabel: Current Label\n' },
      checksums: { 'example_topic.topic': 'checksum-current' },
    }),
    updateModelYamlFile: async () => {
      updateCount += 1;
      return { success: true };
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'update',
      fileName: 'example_topic.topic',
      yaml: 'base_view: example_view\nlabel: Intended Label\n',
      expectedPreWriteSnapshot: {
        exists: true,
        checksum: 'checksum-current',
        yaml: 'base_view: example_view\nlabel: Previously Loaded Label\n',
      },
    }, api),
    /stale or concurrent edit/i,
  );
  assert.equal(updateCount, 0);
});

test('governed topic create rejects a stale absent snapshot before issuing a write', async () => {
  let fetchCount = 0;
  let updateCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return {
        files: { 'example_topic.topic': 'base_view: example_view\n' },
        checksums: { 'example_topic.topic': 'checksum-concurrent-create' },
      };
    },
    updateModelYamlFile: async () => {
      updateCount += 1;
      return { success: true };
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'create',
      fileName: 'example_topic.topic',
      yaml: 'base_view: example_view\nlabel: Intended Topic\n',
      expectedPreWriteSnapshot: { exists: false },
    }, api),
    /stale or concurrent edit.*refresh/i,
  );
  assert.equal(fetchCount, 1);
  assert.equal(updateCount, 0);
});

test('governed topic create confirms an ambiguous network outcome without retrying the write', async () => {
  const requestedYaml = 'base_view: example_view\nlabel: Example Topic\n';
  let fetchCount = 0;
  let updateCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: {}, checksums: {} }
        : { files: { 'example_topic.topic': requestedYaml }, checksums: { 'example_topic.topic': 'checksum-created' } };
    },
    updateModelYamlFile: async () => {
      updateCount += 1;
      throw new Error('Connection closed before the response was received.');
    },
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'create',
    fileName: 'example_topic.topic',
    yaml: requestedYaml,
  }, api);

  assert.equal(updateCount, 1);
  assert.equal(fetchCount, 2);
  assert.equal(evidence.status, 'review_ready');
  assert.deepEqual(evidence.reconciliation, {
    attempted: true,
    outcome: 'confirmed_applied',
    error: 'Connection closed before the response was received.',
  });
});

test('governed topic update confirms an ambiguous timeout with exact intended YAML', async () => {
  const beforeYaml = 'base_view: example_view\nlabel: Old Label\n';
  const intendedYaml = 'base_view: example_view\nlabel: New Label\n';
  let fetchCount = 0;
  let updateCount = 0;
  let previousChecksum: string | undefined;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: { 'example_topic.topic': beforeYaml }, checksums: { 'example_topic.topic': 'checksum-before' } }
        : { files: { 'example_topic.topic': intendedYaml }, checksums: { 'example_topic.topic': 'checksum-after' } };
    },
    updateModelYamlFile: async (_baseUrl, _apiKey, params) => {
      updateCount += 1;
      previousChecksum = params.previousChecksum;
      throw new ApiError(408, 'The request timed out.');
    },
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'update',
    fileName: 'example_topic.topic',
    yaml: intendedYaml,
  }, api);

  assert.equal(updateCount, 1);
  assert.equal(fetchCount, 2);
  assert.equal(previousChecksum, 'checksum-before');
  assert.equal(evidence.after.yaml, intendedYaml);
  assert.equal(evidence.reconciliation.outcome, 'confirmed_applied');
});

test('governed topic create fails closed when ambiguous reconciliation still finds no file', async () => {
  let fetchCount = 0;
  let updateCount = 0;
  let validationCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return { files: {}, checksums: {} };
    },
    updateModelYamlFile: async () => {
      updateCount += 1;
      throw new ApiError(404, 'The response did not confirm the write.');
    },
    validateModel: async () => {
      validationCount += 1;
      return [];
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'create',
      fileName: 'example_topic.topic',
      yaml: 'base_view: example_view\n',
    }, api),
    /ambiguous.*does not exactly match/i,
  );
  assert.equal(updateCount, 1);
  assert.equal(fetchCount, 2);
  assert.equal(validationCount, 0);
});

test('governed topic update fails closed when ambiguous reconciliation finds mismatched YAML', async () => {
  const beforeYaml = 'base_view: example_view\nlabel: Old Label\n';
  const intendedYaml = 'base_view: example_view\nlabel: Intended Label\n';
  const mismatchedYaml = 'base_view: example_view\nlabel: Other Change\n';
  let fetchCount = 0;
  let updateCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: { 'example_topic.topic': beforeYaml }, checksums: { 'example_topic.topic': 'checksum-before' } }
        : { files: { 'example_topic.topic': mismatchedYaml }, checksums: { 'example_topic.topic': 'checksum-other' } };
    },
    updateModelYamlFile: async () => {
      updateCount += 1;
      throw new ApiError(503, 'The service response was unavailable.');
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'update',
      fileName: 'example_topic.topic',
      yaml: intendedYaml,
    }, api),
    /ambiguous.*does not exactly match/i,
  );
  assert.equal(updateCount, 1);
  assert.equal(fetchCount, 2);
});

test('governed topic delete uses branch query parameters and validates the resulting branch', async () => {
  let fetchCount = 0;
  let deleteParams: Parameters<GovernedTopicWriteApi['deleteModelYamlFile']>[2] | undefined;
  let validationCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: { 'example_topic.topic': 'base_view: example_view\n' }, checksums: { 'example_topic.topic': 'checksum-before' } }
        : { files: {}, checksums: {} };
    },
    deleteModelYamlFile: async (_baseUrl, _apiKey, params) => {
      deleteParams = params;
      return { success: true };
    },
    validateModel: async () => {
      validationCount += 1;
      return [];
    },
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'delete',
    fileName: 'example_topic.topic',
    mode: 'extension',
    commitMessage: 'Stage reviewed topic delete',
  }, api);

  assert.equal(deleteParams?.modelId, 'model-1');
  assert.equal(deleteParams?.branchId, 'branch-1');
  assert.equal(deleteParams?.fileName, 'example_topic.topic');
  assert.equal(deleteParams?.mode, 'extension');
  assert.equal(deleteParams?.commitMessage, 'Stage reviewed topic delete');
  assert.equal(validationCount, 1);
  assert.equal(evidence.before.checksum, 'checksum-before');
  assert.equal(evidence.after.exists, false);
  assert.equal(evidence.diff.beforeYaml, 'base_view: example_view\n');
  assert.equal(evidence.diff.afterYaml, '');
  assert.deepEqual(evidence.reconciliation, { attempted: false, outcome: 'not_needed' });
});

test('governed topic delete reconciles one ambiguous failure by refetching once', async () => {
  let fetchCount = 0;
  let contentValidationCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: { 'example_topic.topic': 'base_view: example_view\n' }, checksums: { 'example_topic.topic': 'checksum-before' } }
        : { files: {}, checksums: {} };
    },
    deleteModelYamlFile: async () => {
      throw new Error('Connection closed before the response was received.');
    },
    validateModelContent: async () => {
      contentValidationCount += 1;
      return { content: [] };
    },
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'delete',
    fileName: 'example_topic.topic',
  }, api);

  assert.equal(fetchCount, 2);
  assert.equal(contentValidationCount, 1);
  assert.equal(evidence.status, 'review_ready');
  assert.deepEqual(evidence.reconciliation, {
    attempted: true,
    outcome: 'confirmed_absent',
    error: 'Connection closed before the response was received.',
  });
});

test('governed topic delete blocks review when reconciliation still finds the file', async () => {
  let fetchCount = 0;
  let validationCount = 0;
  const existing = {
    files: { 'example_topic.topic': 'base_view: example_view\n' },
    checksums: { 'example_topic.topic': 'checksum-before' },
  };
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return existing;
    },
    deleteModelYamlFile: async () => {
      throw new Error('Connection closed before the response was received.');
    },
    validateModel: async () => {
      validationCount += 1;
      return [];
    },
  });

  await assert.rejects(
    stageGovernedTopicMutation(connection, reviewedBranch(), {
      action: 'delete',
      fileName: 'example_topic.topic',
    }, api),
    /ambiguous.*still present/i,
  );
  assert.equal(fetchCount, 2);
  assert.equal(validationCount, 0);
});

test('governed topic evidence blocks publish review when branch validation fails', async () => {
  const requestedYaml = 'base_view: example_view\n';
  let fetchCount = 0;
  const api = mockApi({
    getModelYaml: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { files: {}, checksums: {} }
        : { files: { 'example_topic.topic': requestedYaml }, checksums: { 'example_topic.topic': 'checksum-created' } };
    },
    validateModel: async () => [{ message: 'Invalid topic field', is_warning: false }],
    validateModelContent: async () => ({
      content: [{ queries_and_issues: [{ issues: ['Missing field'] }] }],
    }),
  });

  const evidence = await stageGovernedTopicMutation(connection, reviewedBranch(), {
    action: 'create',
    fileName: 'example_topic.topic',
    yaml: requestedYaml,
  }, api);

  assert.equal(evidence.status, 'validation_blocked');
  assert.equal(evidence.validation.blocking, true);
  assert.equal(evidence.validation.modelIssues.length, 1);
  assert.equal(evidence.validation.contentIssueCount, 1);
  assert.equal(evidence.published, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS,
  SEMANTIC_MIGRATION_COMPILE_CONTRACT,
  SEMANTIC_MIGRATION_PLAN_CONTRACT,
  SEMANTIC_MIGRATION_REPAIR_CONTRACT,
  assertFreshSemanticMigrationStageMetadata,
  assertSemanticMigrationStageOutput,
  createFreshSemanticMigrationStageMetadata,
  nextSemanticMigrationRepairAttempt,
  semanticMigrationStageContract,
  validateSemanticMigrationStageOutput,
  type SemanticMigrationCompileV2Output,
} from '../src/services/semanticMigration/contracts';
import {
  buildSemanticMigrationCompilePrompt,
  buildSemanticMigrationRepairPrompt,
  semanticMigrationPlacementTargetFileName,
  type SemanticMigrationCompilePromptInput,
} from '../src/services/semanticMigration/compilePipeline';
import {
  SemanticMigrationCompileOutputError,
  normalizeStructuredGenerationInput,
  postValidateStructuredGenerationResult,
  runStructuredGenerationWithOutputRetry,
  type StructuredGenerationInput,
} from '../server/services/migrationProviders';
import {
  ProviderStructuredOutputError,
  parseProviderStructuredOutput,
  providerStructuredOutputNotice,
} from '../src/services/semanticMigration/providerOutput';

const BASELINE_DIGEST = 'a'.repeat(64);

function compileInput(): SemanticMigrationCompilePromptInput {
  return {
    targetModel: { id: 'model-1', name: 'Target model' },
    sourcePlatform: 'example_source',
    migrationGoal: 'Create the approved semantic objects.',
    runId: 'compile-run-1',
    parentRunId: 'plan-run-1',
    approvedDecisions: [{
      id: 'decision:view:orders',
      nodeId: 'view:orders',
      semanticKind: 'view',
      action: 'create_new',
      targetFileName: 'orders.view',
      targetLabel: 'Orders',
      approvedDefinition: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id',
      rationale: 'The selected source table has direct column evidence.',
      evidenceIds: ['evidence:orders'],
      approvedByUser: true,
    }],
    approvedPlacements: [{
      id: 'placement:view:orders',
      nodeId: 'view:orders',
      sourceKind: 'view',
      sourceName: 'Orders',
      approvedTarget: 'omni_view',
      targetObjectName: 'orders',
      rationale: 'The object is query-time semantic metadata.',
      evidenceIds: ['evidence:orders'],
      approvedByUser: true,
    }],
    evidenceSummaries: [{
      id: 'evidence:orders',
      sourceId: 'source:orders',
      locator: 'metadata/orders',
      summary: 'Orders table with a directly observed order_id column.',
      contentSha256: 'b'.repeat(64),
    }],
    baselineDigests: [{ fileName: 'orders.view', digest: BASELINE_DIGEST, apiChecksum: 'omni-checksum-1' }],
  };
}

function validCompileOutput(): SemanticMigrationCompileV2Output {
  return {
    contractVersion: SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    stage: 'compile',
    status: 'writes',
    message: 'Compiled one approved semantic file.',
    files: [{
      fileName: 'orders.view',
      yaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id',
      decisionIds: ['decision:view:orders'],
      placementIds: ['placement:view:orders'],
      evidenceIds: ['evidence:orders'],
      definitions: [
        {
          path: '$',
          decisionIds: ['decision:view:orders'],
          placementIds: ['placement:view:orders'],
          evidenceIds: ['evidence:orders'],
        },
        {
          path: 'dimensions.order_id',
          decisionIds: ['decision:view:orders'],
          placementIds: ['placement:view:orders'],
          evidenceIds: ['evidence:orders'],
        },
      ],
      baseDigest: BASELINE_DIGEST,
    }],
    warnings: [],
  };
}

test('placement target files normalize display labels and keep granular objects in their governed container', () => {
  assert.equal(semanticMigrationPlacementTargetFileName({
    approvedTarget: 'omni_view',
    sourceKind: 'view',
    targetObjectName: 'Menu Item P&L',
  }), 'menu_item_p_l.view');
  assert.equal(semanticMigrationPlacementTargetFileName({
    approvedTarget: 'omni_query_view',
    sourceKind: 'transformation',
    targetObjectName: 'Daily Grill / Store Rollup',
  }), 'store_rollup.query.view');
  assert.equal(semanticMigrationPlacementTargetFileName({
    approvedTarget: 'omni_view',
    sourceKind: 'relationship',
  }), 'relationships');
  assert.equal(semanticMigrationPlacementTargetFileName({
    approvedTarget: 'omni_view',
    sourceKind: 'measure',
    targetObjectName: 'Attach Rate',
  }), undefined);
  assert.equal(semanticMigrationPlacementTargetFileName({
    approvedTarget: 'omni_view',
    sourceKind: 'measure',
    targetFileName: 'daily_grill_report.view',
    targetObjectName: 'Attach Rate',
  }), 'daily_grill_report.view');
});

test('plan.v2, compile.v2, and repair.v2 expose versioned provider-safe contracts', () => {
  assert.equal(semanticMigrationStageContract(SEMANTIC_MIGRATION_PLAN_CONTRACT).schemaName, 'semantic_migration_plan_v2');
  assert.equal(semanticMigrationStageContract(SEMANTIC_MIGRATION_COMPILE_CONTRACT).stage, 'compile');
  assert.equal(semanticMigrationStageContract(SEMANTIC_MIGRATION_REPAIR_CONTRACT).stage, 'repair');

  const plan = validateSemanticMigrationStageOutput(SEMANTIC_MIGRATION_PLAN_CONTRACT, {
    contractVersion: SEMANTIC_MIGRATION_PLAN_CONTRACT,
    stage: 'plan',
    status: 'ready',
    message: 'The evidence is ready for operator review.',
    decisions: [],
    dashboardPlans: [],
    warnings: [],
  });
  assert.equal(plan.ok, true, plan.issues.join('\n'));

  const repairNoChange = validateSemanticMigrationStageOutput(SEMANTIC_MIGRATION_REPAIR_CONTRACT, {
    contractVersion: SEMANTIC_MIGRATION_REPAIR_CONTRACT,
    stage: 'repair',
    attempt: 1,
    status: 'no_change',
    message: 'No semantic writes were authorized.',
    files: [],
    warnings: [],
  }, { expectedWriteCount: 0, repairAttempt: 1 });
  assert.equal(repairNoChange.ok, true, repairNoChange.issues.join('\n'));
});

test('compile prompt contains structured approvals and digests but no raw plan prose or conversation', () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());

  assert.equal(request.semanticMigrationContract.id, SEMANTIC_MIGRATION_COMPILE_CONTRACT);
  assert.equal(request.conversationId, undefined);
  assert.equal(request.stageMetadata.conversationMode, 'fresh');
  assert.equal(request.stageMetadata.parentRunId, 'plan-run-1');
  assert.match(request.prompt, /decision:view:orders/);
  assert.match(request.prompt, /placement:view:orders/);
  assert.match(request.prompt, /evidence:orders/);
  assert.match(request.prompt, new RegExp(BASELINE_DIGEST));
  assert.doesNotMatch(request.prompt, /PLAN\s+ONLY|NO[\s_-]*YAML|do not return (?:deployable )?yaml/i);
});

test('compile and repair reject raw plan fields and inherited YAML prohibitions', () => {
  const rawPlanInput = {
    ...compileInput(),
    planMessage: 'PLAN ONLY. Do not return deployable YAML.',
  } as SemanticMigrationCompilePromptInput;
  assert.throws(() => buildSemanticMigrationCompilePrompt(rawPlanInput), /stage isolation|raw-plan/i);

  assert.throws(() => buildSemanticMigrationCompilePrompt({
    ...compileInput(),
    migrationGoal: 'NO YAML should be generated by the next stage.',
  }), /no-YAML directive/i);
});

test('compile rejects files:[] for required writes and accepts an explicit no-op', () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());
  const emptyWriteResult = validateSemanticMigrationStageOutput(SEMANTIC_MIGRATION_COMPILE_CONTRACT, {
    contractVersion: SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    stage: 'compile',
    status: 'writes',
    message: 'Nothing generated.',
    files: [],
    warnings: [],
  }, request.semanticMigrationContract.validationContext);
  assert.equal(emptyWriteResult.ok, false);
  assert.match(emptyWriteResult.issues.join('\n'), /files:\[\]|not covered/i);

  const noOp = assertSemanticMigrationStageOutput(SEMANTIC_MIGRATION_COMPILE_CONTRACT, {
    contractVersion: SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    stage: 'compile',
    status: 'no_op',
    message: 'No approved semantic writes.',
    files: [],
    warnings: [],
  }, { expectedWriteCount: 0, approvedIntentIds: [], allowedFileNames: [], allowedEvidenceIds: [], baselineDigests: {} });
  assert.equal(noOp.status, 'no_op');
});

test('compile post-validation enforces intent, evidence, target file, and baseline attribution', () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());
  const output = assertSemanticMigrationStageOutput(
    SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    validCompileOutput(),
    request.semanticMigrationContract.validationContext,
  );
  assert.equal(output.files.length, 1);

  const wrongBaseline = validCompileOutput();
  wrongBaseline.files[0] = { ...wrongBaseline.files[0]!, baseDigest: 'c'.repeat(64) };
  assert.throws(() => assertSemanticMigrationStageOutput(
    SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    wrongBaseline,
    request.semanticMigrationContract.validationContext,
  ), /baseline digest/i);

  const missingDefinitionEvidence = validCompileOutput();
  missingDefinitionEvidence.files[0] = {
    ...missingDefinitionEvidence.files[0]!,
    yaml: `${missingDefinitionEvidence.files[0]!.yaml}\nmeasures:\n  invented_revenue:\n    sql: SUM(\${TABLE}.revenue)`,
  };
  assert.throws(() => assertSemanticMigrationStageOutput(
    SEMANTIC_MIGRATION_COMPILE_CONTRACT,
    missingDefinitionEvidence,
    request.semanticMigrationContract.validationContext,
  ), /measures\.invented_revenue.*no approved intent and evidence attribution/i);
});

test('fresh-stage metadata drops conversation state and repair is bounded to one attempt', () => {
  const compileMetadata = createFreshSemanticMigrationStageMetadata('compile', 'compile-run', { parentRunId: 'plan-run' });
  assert.equal(compileMetadata.conversationId, undefined);
  assertFreshSemanticMigrationStageMetadata(compileMetadata, 'compile');
  assert.throws(() => assertFreshSemanticMigrationStageMetadata({
    ...compileMetadata,
    conversationId: 'plan-conversation',
  } as typeof compileMetadata, 'compile'), /fresh AI conversation/i);

  assert.equal(nextSemanticMigrationRepairAttempt(0), MAX_SEMANTIC_MIGRATION_REPAIR_ATTEMPTS);
  assert.throws(() => nextSemanticMigrationRepairAttempt(1), /already been used/i);

  const compileRequest = buildSemanticMigrationCompilePrompt(compileInput());
  const repairRequest = buildSemanticMigrationRepairPrompt({
    targetModel: { id: 'model-1', name: 'Target model' },
    runId: 'repair-run-1',
    parentRunId: 'compile-run-1',
    previousRepairAttempts: 0,
    currentFiles: validCompileOutput().files,
    validationIssues: [{ id: 'yaml-shape', fileName: 'orders.view', path: 'dimensions.order_id', message: 'sql is required.' }],
    validationContext: compileRequest.semanticMigrationContract.validationContext,
  });
  assert.equal(repairRequest.conversationId, undefined);
  assert.equal(repairRequest.stageMetadata.repairAttempt, 1);
  assert.doesNotMatch(repairRequest.prompt, /PLAN\s+ONLY|NO[\s_-]*YAML|do not return (?:deployable )?yaml/i);

  assert.throws(() => buildSemanticMigrationRepairPrompt({
    targetModel: { id: 'model-1', name: 'Target model' },
    runId: 'repair-run-2',
    parentRunId: 'compile-run-1',
    previousRepairAttempts: 1,
    currentFiles: validCompileOutput().files,
    validationIssues: [{ id: 'yaml-shape', message: 'sql is required.' }],
    validationContext: compileRequest.semanticMigrationContract.validationContext,
  }), /already been used/i);
});

test('provider integration uses the registered schema and post-validates every contracted result', () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());
  const providerInput: StructuredGenerationInput = {
    task: request.task,
    system: request.system,
    prompt: request.prompt,
    schemaName: 'caller_controlled_schema',
    schema: { type: 'string' },
    targetModelId: request.targetModelId,
    semanticMigrationContract: request.semanticMigrationContract,
  };
  const normalized = normalizeStructuredGenerationInput(providerInput);
  assert.equal(normalized.schemaName, 'semantic_migration_compile_v2');
  assert.equal(normalized.schema, semanticMigrationStageContract(SEMANTIC_MIGRATION_COMPILE_CONTRACT).schema);

  const accepted = postValidateStructuredGenerationResult(normalized, {
    providerKind: 'openai',
    model: 'test-model',
    rawText: JSON.stringify(validCompileOutput()),
    output: validCompileOutput(),
  });
  assert.equal((accepted.output as SemanticMigrationCompileV2Output).status, 'writes');

  assert.throws(() => postValidateStructuredGenerationResult(normalized, {
    providerKind: 'omni_ai',
    model: 'test-model',
    rawText: '{"files":[]}',
    output: {
      contractVersion: SEMANTIC_MIGRATION_COMPILE_CONTRACT,
      stage: 'compile',
      status: 'writes',
      message: 'Empty result.',
      files: [],
      warnings: [],
    },
  }), /files:\[\]/i);
});

test('provider JSON handling safely extracts one value and reports deterministic repairs', () => {
  const strict = parseProviderStructuredOutput('{"ok":true,"yaml":"sql: ${TABLE}.amount, gross"}');
  assert.deepEqual(strict.value, { ok: true, yaml: 'sql: ${TABLE}.amount, gross' });
  assert.deepEqual(strict.handling, {
    parseMode: 'strict',
    extracted: false,
    repairs: [],
  });

  const extracted = parseProviderStructuredOutput('Provider response:\n```json\n{"ok":true}\n```');
  assert.deepEqual(extracted.value, { ok: true });
  assert.deepEqual(extracted.handling, {
    parseMode: 'extracted',
    extracted: true,
    repairs: [],
  });

  const repaired = parseProviderStructuredOutput([
    'Provider response:',
    '```json',
    '{',
    '  "message": "Compiled",',
    '  "yaml": "dimensions:',
    '  order_id:',
    '    sql: ${TABLE}.order_id",',
    '}',
    '```',
  ].join('\n'));
  assert.deepEqual(repaired.value, {
    message: 'Compiled',
    yaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id',
  });
  assert.equal(repaired.handling.parseMode, 'repaired');
  assert.equal(repaired.handling.extracted, true);
  assert.deepEqual(repaired.handling.repairs.sort(), ['escaped_control_characters', 'removed_trailing_commas']);
  assert.match(providerStructuredOutputNotice(repaired.handling) || '', /repaired deterministic JSON syntax/i);
  assert.match(providerStructuredOutputNotice(repaired.handling) || '', /contract validation/i);
});

test('BOM, control-character, and trailing-comma repairs preserve decoded SQL and YAML exactly', () => {
  const bom = parseProviderStructuredOutput('\uFEFF{"ok":true}');
  assert.deepEqual(bom.value, { ok: true });
  assert.deepEqual(bom.handling, {
    parseMode: 'repaired',
    extracted: false,
    repairs: ['removed_utf8_bom'],
  });
  const fencedBom = parseProviderStructuredOutput('```json\n\uFEFF{"ok":true}\n```');
  assert.deepEqual(fencedBom.value, { ok: true });
  assert.deepEqual(fencedBom.handling, {
    parseMode: 'repaired',
    extracted: true,
    repairs: ['removed_utf8_bom'],
  });

  const expectedYaml = 'sql: COALESCE(${TABLE}.amount, 0),\r\n  literal: },\t';
  const repaired = parseProviderStructuredOutput('{"yaml":"sql: COALESCE(${TABLE}.amount, 0),\r\n  literal: },\t",}');
  assert.deepEqual(repaired.value, { yaml: expectedYaml });
  assert.equal((repaired.value as { yaml: string }).yaml, expectedYaml);
  assert.deepEqual(repaired.handling.repairs.sort(), ['escaped_control_characters', 'removed_trailing_commas']);
});

test('provider JSON handling rejects ambiguous and irreparable output instead of choosing a fragment', () => {
  assert.throws(
    () => parseProviderStructuredOutput('{"first":true}\n{"second":true}'),
    (error: unknown) => error instanceof ProviderStructuredOutputError && error.reason === 'ambiguous',
  );
  assert.throws(
    () => parseProviderStructuredOutput('{"first":true}\n{"second":true,}'),
    (error: unknown) => error instanceof ProviderStructuredOutputError && error.reason === 'ambiguous',
  );
  assert.throws(
    () => parseProviderStructuredOutput('{]\n{"second":true}'),
    (error: unknown) => error instanceof ProviderStructuredOutputError && error.reason === 'ambiguous',
  );
  assert.throws(
    () => parseProviderStructuredOutput('{"truncated":true'),
    (error: unknown) => error instanceof ProviderStructuredOutputError && error.reason === 'malformed',
  );
});

test('contract-invalid semantic compile output gets one fresh provider retry', async () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());
  const normalized = normalizeStructuredGenerationInput({
    task: request.task,
    system: request.system,
    prompt: request.prompt,
    schemaName: request.schemaName,
    schema: request.schema,
    targetModelId: request.targetModelId,
    semanticMigrationContract: request.semanticMigrationContract,
  });
  const attemptedSystems: string[] = [];
  const result = await runStructuredGenerationWithOutputRetry(normalized, async (attemptInput, attempt) => {
    attemptedSystems.push(attemptInput.system);
    const output = attempt === 1
      ? { ...validCompileOutput(), files: [] }
      : validCompileOutput();
    return {
      providerKind: 'openai',
      model: 'test-model',
      rawText: JSON.stringify(output),
      output,
    };
  });

  assert.equal(attemptedSystems.length, 2);
  assert.doesNotMatch(attemptedSystems[0]!, /single bounded provider retry/i);
  assert.match(attemptedSystems[1]!, /single bounded provider retry/i);
  assert.match(attemptedSystems[1]!, /Do not copy or infer from the rejected response/i);
  assert.equal(result.outputHandling?.providerAttempts, 2);
  assert.equal(result.outputHandling?.automaticRetry, true);
  assert.equal((result.output as SemanticMigrationCompileV2Output).status, 'writes');
  assert.match(providerStructuredOutputNotice(result.outputHandling) || '', /automatic attempt 2/i);
});

test('malformed provider JSON gets one retry without echoing the rejected response', async () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());
  const normalized = normalizeStructuredGenerationInput({
    task: request.task,
    system: request.system,
    prompt: request.prompt,
    schemaName: request.schemaName,
    schema: request.schema,
    targetModelId: request.targetModelId,
    semanticMigrationContract: request.semanticMigrationContract,
  });
  const rejectedResponse = '{"truncated-provider-secret":';
  const result = await runStructuredGenerationWithOutputRetry(normalized, async (attemptInput, attempt) => {
    assert.doesNotMatch(attemptInput.system, /truncated-provider-secret/);
    if (attempt === 1) {
      parseProviderStructuredOutput(rejectedResponse);
      throw new Error('Unreachable parse branch.');
    }
    const output = validCompileOutput();
    return {
      providerKind: 'openai',
      model: 'test-model',
      rawText: JSON.stringify(output),
      output,
    };
  });

  assert.equal(result.outputHandling?.providerAttempts, 2);
  assert.equal(result.outputHandling?.automaticRetry, true);
});

test('two unusable compile responses produce a retryable terminal error and no output', async () => {
  const request = buildSemanticMigrationCompilePrompt(compileInput());
  const normalized = normalizeStructuredGenerationInput({
    task: request.task,
    system: request.system,
    prompt: request.prompt,
    schemaName: request.schemaName,
    schema: request.schema,
    targetModelId: request.targetModelId,
    semanticMigrationContract: request.semanticMigrationContract,
  });
  let attempts = 0;

  await assert.rejects(
    () => runStructuredGenerationWithOutputRetry(normalized, async () => {
      attempts += 1;
      const output = { ...validCompileOutput(), files: [] };
      return {
        providerKind: 'openai',
        model: 'test-model',
        rawText: JSON.stringify(output),
        output,
      };
    }),
    (error: unknown) => error instanceof SemanticMigrationCompileOutputError
      && error.code === 'SEMANTIC_COMPILE_OUTPUT_INVALID'
      && error.retryable
      && error.attempts === 2
      && /discarded the responses/i.test(error.message),
  );
  assert.equal(attempts, 2);
});

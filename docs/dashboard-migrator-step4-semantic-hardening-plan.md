# Dashboard Migrator Step 4 Semantic Hardening Plan

## Summary

Raise confidence in Dashboard Migrator Step 4 by making semantic differences explicit, classifying their risk, validating selected decisions before import, and protecting model writes from stale target state. The desired workflow is:

1. OmniKit notifies the user that source and destination model/topic/query-view code differs.
2. The user chooses how to resolve each variance: ignore, map, add/create, update, or manually edit.
3. OmniKit applies only the selected decisions to the target model layer.
4. Model fields, topics, query views, and relationships are updated or mapped before dashboard import.
5. Dashboard copy/import runs only after the dependency prep path is ready.

## Phase 1: Difference Classification And Dependency Graph

- Add semantic patch safety categories:
  - `safe_ignore`
  - `safe_map`
  - `safe_create`
  - `safe_update`
  - `destructive_update`
  - `manual_review`
  - `blocked`
- Attach classification metadata to every semantic patch candidate.
- Attach dependency graph metadata so Step 4 can explain why a patch exists:
  - dashboard -> topic
  - topic -> query view
  - query view -> model field
  - model field -> model field/relationship when detected
- Validation checkpoint: preflight details show structured semantic patch candidates with category and dependency nodes, without executing unaccepted candidates.

## Phase 2: Pre-Run Semantic Validation

- Build a semantic validation summary from selected Step 4 decisions before Step 5.
- Block readiness when:
  - selected patches have no accepted YAML
  - destructive source replacement is not confirmed
  - the patch is classified as blocked/manual review and has not been explicitly resolved
  - a selected patch targets a missing file without source/proposed YAML
- Surface validation state in Step 4 using user-facing language: ready, warning, blocked.
- Validation checkpoint: Step 5 cannot start when selected semantic decisions are incomplete or unsafe.

## Phase 3: Checksum And Concurrency Protection

- Require `previousChecksum` for update-style patches when a target file already exists and the checksum is known.
- Preserve explicit checksum on patch writes.
- If the target checksum is missing for an update-style patch, mark the patch as warning/manual-review instead of treating it as silently safe.
- If Omni rejects a write due to stale checksum or model protection, fail the prep step and skip dependent imports.
- Validation checkpoint: stale/missing checksum scenarios are surfaced before run and protected during execution.

## Phase 4: Step 4 UX Wiring

- Keep Guided choices as the default mode.
- Make Code review summarize:
  - what differs
  - why it matters
  - recommended action
  - safety classification
  - dependency path
- Keep raw YAML editor available for power users, but do not require non-technical users to edit YAML for normal create/map/update decisions.
- Validation checkpoint: the user can understand each variance as a resolvable dependency, not a noisy warning dump.

## Phase 5: Ugly-Case Fixtures

- Add or extend tests for:
  - missing measure with source YAML
  - renamed/source-prefixed field with mapping decision
  - topic references missing query view
  - query view references missing relationship
  - target same field name but different definition
  - target custom code preserved unless update is accepted
  - same dashboard routed to two folders in the same semantic destination
  - same dashboard routed to two different target models
- Validation checkpoint: tests prove selected decisions drive model prep and unresolved differences block import.

## Phase 6: Final Validation

- Run:
  - `npm run test:dashboard-migration`
  - `npm run test:migration-planner`
  - `npm run test:security`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`
  - `npm run lint`
  - `git diff --check`
- Compare each phase back to this requirements document.

## Completion Review

- Phase 1 complete: semantic patch candidates now carry `safetyCategory`, `recommendedAction`, and `dependencyPath` metadata for field, query-view, topic, and relationship changes.
- Phase 2 complete: selected Step 4 code decisions are validated before readiness. Empty YAML, blocked decisions, and unconfirmed destructive changes block progression.
- Phase 3 complete: accepted semantic patches are guarded at execution time. Blocked or unconfirmed destructive patches fail prep and skip dependent import work; accepted writes use reviewed or latest runtime checksums.
- Phase 4 complete: Code review now shows plain-language safety labels, recommended actions, and dependency-path breadcrumbs above the YAML editor.
- Phase 5 complete: added planner, wizard, and security coverage for safety metadata, dependency metadata, draft redaction, and unsafe accepted patch execution.
- Phase 6 complete: validation commands were run after implementation.

## Validation Results

- `npm run test:dashboard-migration` passed.
- `npm run test:migration-planner` passed.
- `npm run test:security` passed.
- `npm run typecheck` passed.
- `npm run typecheck:node` passed.
- `npm run build` passed.
- `npm run lint` passed with existing Fast Refresh warnings in shared UI/context modules.
- `git diff --check` passed.

## Assumptions

- Step 4 remains a controlled dependency-resolution workflow, not a full Git merge client.
- Advanced Code review remains available, but safe guided choices remain the default for analysts.
- OmniKit should never apply unaccepted preflight patch candidates.
- Active migration jobs may carry accepted YAML needed for execution; reusable drafts and job item history must continue redacting raw YAML.
- Full dev-branch semantic validation is desirable future work if Omni exposes a safe branch-write path for this workflow; this phase focuses on local readiness validation plus write-time protection.

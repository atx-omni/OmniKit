# Dashboard Migrator Advanced Code Review Plan

## Summary

Add an Advanced Code Review mode to Dashboard Migrator Step 4. Guided dependency resolution remains the default experience, while advanced users can inspect and edit the exact model, query-view, topic, and relationship YAML patches OmniKit will apply before dashboard import.

## Phase 1: Patch Contract And State

- Add a route-scoped semantic patch draft contract for accepted YAML edits.
- Carry patch metadata through migration targets and route groups without saving raw YAML in reusable wizard drafts.
- Keep source/current/proposed YAML tied to target model, file name, artifact type, checksum, route group, and target row.
- Validation checkpoint: route-group conversion includes accepted patches in job input, and draft storage strips raw patch YAML.

## Phase 2: Patch Candidate Extraction

- Extract patch candidates from readiness/preflight plan details for field, query-view, topic, and relationship prep steps.
- For v1, generate candidates from existing prep details and planned mappings:
  - fields use source field YAML or compatibility alias context when available
  - query views use required query-view/mapping details
  - topics use topic mapping details
  - relationships use relationship edge details
- Validation checkpoint: Step 4 can build a stable file list from the current readiness plan without hiding guided resolver rows.

## Phase 3: Advanced Code Review UI

- Add Step 4 tabs: Guided choices and Code review.
- Code review groups patches by route and destination model.
- Each patch shows source/current/proposed YAML using existing lightweight diff/text-area patterns.
- Add actions: Apply recommended patch, Keep target, Use source when safe, Reset edit.
- Mark edited patches as custom edits and show destructive warnings for full-source replacement of an existing file.
- Validation checkpoint: unresolved/invalid patches block readiness review, while guided-only usage still works unchanged.

## Phase 4: Migration Execution

- Apply accepted semantic patches during the matching prep step before dashboard import.
- Prefer accepted patch YAML over regenerated defaults when present.
- Use `updateModelYamlFile` with `previousChecksum`.
- If a patch write fails, fail the prep step and skip dependent imports.
- Preserve current protected/git-required model blockers.
- Validation checkpoint: accepted field/query-view/topic/relationship patches are written before import and reported in job item details.

## Phase 5: Tests And Validation

- Wizard tests:
  - guided flow works without opening Code review
  - code review exposes patch candidates
  - editing proposed YAML marks a patch custom
  - Keep target removes write intent
  - destructive Use source requires confirmation metadata
  - raw YAML is not persisted in reusable drafts
- Planner/job tests:
  - accepted patch writes before import
  - checksum mismatch fails prep and skips import
  - protected model blocks direct patch writes
- Regression commands:
  - `npm run test:dashboard-migration`
  - `npm run test:migration-planner`
  - `npm run test:security`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`

## Completion Review

- Phase 1 complete: semantic patch contracts now flow through route groups, migration targets, server parsing, and reusable draft storage. Draft persistence strips raw YAML while preserving audit metadata.
- Phase 2 complete: readiness/preflight now emits patch candidates for model fields, query views, topics, and relationships. Candidates are display-only until a user explicitly accepts or edits YAML.
- Phase 3 complete: Step 4 includes Guided choices and Code review modes. Code review groups duplicated folder routes by shared destination model so one model/topic/query-view decision can apply across same-instance/same-connection/same-model routes.
- Phase 4 complete: accepted semantic patches are applied during the matching prep step before dashboard import, with failed writes blocking dependent imports. Unaccepted candidates do not execute.
- Phase 5 complete: added wizard, planner, and security coverage for accepted semantic patches, preflight blockers, and draft redaction.

## Validation Results

- `npm run test:dashboard-migration` passed.
- `npm run test:migration-planner` passed.
- `npm run test:security` passed.
- `npm run typecheck` passed.
- `npm run typecheck:node` passed.
- `npm run build` passed.
- `npm run lint` passed with existing Fast Refresh warnings in shared UI/context modules and no dashboard migrator warnings.
- `git diff --check` passed.

## Assumptions

- Guided dependency resolution stays the default Step 4 mode.
- V1 uses native diff and textarea UI, not Monaco or CodeMirror.
- “Map existing” continues to create a compatibility alias unless a future enhancement adds dashboard payload field rewriting.
- Full pre-Step-5 branch validation is out of scope for v1; migration prep remains the authoritative write point.
- Raw YAML is allowed in active migration job payloads with existing sanitization, but not in reusable draft storage.

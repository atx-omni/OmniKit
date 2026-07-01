# Dashboard Migrator Field Dependency Resolution Plan

## Summary

The Dashboard Migrator currently detects missing target model fields and surfaces them as warnings or blockers. That is safer than silently importing broken dashboards, but it still leaves users with a warning-heavy bypass instead of a resolution path.

The goal is to turn missing measures and dimensions into first-class semantic dependencies that can be resolved in the dependency resolution step before review and run.

## Current Problem

- Query views and topics already have structured resolution paths.
- Missing target model fields are still mostly string-shaped warnings such as `referenced fields were not found in the destination model`.
- Topic-backed dashboards may now block on unresolved fields, but the user still cannot fix those fields inside the workflow.
- Review is doing too much diagnostic work. Dependency resolution should be where users fix the migration.

## Desired User Experience

When a dashboard references a measure or dimension that does not exist in the target model, OmniKit should show it in the dependency resolution step and let the user choose:

- Map the source field to an existing target field.
- Create/copy the field from the source model when OmniKit can safely locate its YAML definition.
- Ignore the field and proceed with a clear audit warning.

Warnings should remain visible only as supporting context: "this is not going to completely work unless resolved." The primary path should be a checklist-style dependency resolver.

## Key Changes

### Structured Field Dependencies

Add a first-class dependency model for missing semantic fields:

- source field reference, such as `orders.total_revenue`
- field kind: dimension, measure, or unknown
- source view name
- source field name
- source file name when available
- source YAML snippet or field YAML when safely extractable
- target candidates
- selected action
- resolution status
- warnings/blockers

### Supported Actions

- `map_existing`: map the source field reference to an existing target field.
- `create_from_source`: create or copy the field definition from the source model into the target model.
- `ignore`: intentionally proceed without resolving the field.
- `unresolved`: block until the user chooses a resolution.

### Preflight Behavior

- Query-view-supplied fields must continue to be resolved by query-view preparation and should not duplicate as field dependencies.
- Remaining missing fields should become structured field dependencies instead of only warnings.
- Exact target matches should be auto-resolved where safe.
- Similar target candidates should be suggested but not silently accepted.
- Missing fields with no source YAML or unsafe dependencies should become blockers unless ignored.

### Step 4 Dependency Resolution

Add a "Field & measure dependencies" section to the dependency resolution step.

For each dashboard group and destination route, users should be able to:

- see missing fields grouped by source view/dashboard
- choose map/create/ignore
- inspect candidate target fields
- see whether each field is ready, warning, or blocked
- proceed only when all required dependencies are resolved or intentionally ignored

### Review Impact

Review should summarize decisions instead of dumping repeated warnings:

- fields mapped
- fields created
- fields ignored
- unresolved blockers
- query-view actions
- relationship actions
- topic actions

Ignored fields should remain as explicit warnings.

### Execution

Add a field/model preparation job step before query-view, relationship, topic, and import steps.

Execution order:

1. Export dashboard.
2. Prepare model fields.
3. Prepare query views.
4. Prepare relationships.
5. Prepare topics.
6. Import dashboard.
7. Preserve metadata.
8. Run schema refresh/source delete post-actions.

If field preparation fails, downstream route steps must be skipped and source delete must not run.

### YAML Safety

Creating from source must be conservative:

- copy only selected fields
- preserve target-only fields
- avoid overwriting target fields unless explicitly supported later
- preserve dimensions, measures, aggregate metadata, SQL, labels, descriptions, and formatting
- detect dependent missing fields
- block protected/pull-request-required target models
- audit source and target file names

### Audit And Security

- Record created, mapped, ignored, and unresolved field dependencies in job details.
- Avoid storing secrets or raw credentials in details.
- Keep field SQL/YAML snippets scoped to model metadata only.
- Preserve existing sanitizer behavior and add coverage for new details.

## Test Plan

- Missing target measure becomes a field dependency instead of only a warning.
- Query-view-supplied fields do not appear as field dependencies.
- Exact target field mappings can be resolved.
- Create-from-source writes a target field into the correct YAML section.
- Existing target fields are preserved.
- Dependent missing fields are surfaced.
- Ignored fields become explicit warnings but allow review/run.
- Unresolved fields block import.
- Protected target models block create-from-source actions.
- Review impact shows field actions and no repeated warning dump.

## Validation Commands

- `npm run test:migration-planner`
- `npm run test:dashboard-migration`
- `npm run test:security`
- `npm run typecheck`
- `npm run typecheck:node`
- `npm run build`
- `git diff --check`

## Implementation Phases

### Phase 1: Shared Contract

- Added first-class field dependency, candidate, and mapping types to the client/server migration contracts.
- Added `field_prepare` as a job item kind.
- Extended Dashboard Migrator target drafts, route groups, API parsing, and job input conversion to carry field mappings without credential data.

Validation:

- `npm run test:dashboard-migration`

### Phase 2: Planner Detection

- Converted unresolved model fields into structured field dependencies instead of repeated warning-only messages.
- Preserved query-view-supplied field behavior so fields prepared by query views are not duplicated as model-field dependencies.
- Surfaced missing dependent fields referenced inside create-from-source field YAML so users can resolve the full chain before import.
- Added candidate suggestions for exact, field-name, normalized, and label matches.
- Added protected-model blocking for YAML-changing field actions.

Validation:

- `npm run test:migration-planner`

### Phase 3: Resolution UX

- Added field and measure decisions to the dependency resolution step.
- Let users map to an existing target field, create from source YAML, or intentionally ignore.
- Grouped decisions by semantic destination so duplicate folder routes in the same target model share one set of choices.
- Added preflight gating for unresolved field decisions.

Validation:

- `npm run test:dashboard-migration`
- `npm run typecheck`

### Phase 4: Review Impact

- Added field action counts and summaries to review impact and route cards.
- Kept ignored fields as explicit warnings while avoiding the old repeated warning dump for resolvable fields.
- Preserved query-view, relationship, and topic summaries alongside the new field actions.

Validation:

- `npm run test:dashboard-migration`
- `npm run typecheck`

### Phase 5: Execution

- Added field preparation after export and before query-view, relationship, topic, and import steps.
- Implemented conservative create-from-source and map-existing alias YAML writes.
- Preserved target-only fields by appending selected fields instead of overwriting complete view files.
- Skips downstream route work when field preparation fails.

Validation:

- `npm run test:migration-planner`
- `npm run typecheck:node`
- `npm run test:security`

### Phase 6: Release Validation

- Ran the saved validation suite for the completed field dependency workflow.
- Confirmed production build and whitespace checks pass.

Validation:

- `npm run test:migration-planner`
- `npm run test:dashboard-migration`
- `npm run test:security`
- `npm run typecheck`
- `npm run typecheck:node`
- `npm run build`
- `git diff --check`

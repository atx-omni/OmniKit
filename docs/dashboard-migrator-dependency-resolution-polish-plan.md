# Dashboard Migrator Dependency Resolution Polish Plan

## Summary

The Dashboard Migrator now detects model-field, query-view, and topic dependencies before import. The remaining work is to make Step 4 reliable and clear so users can resolve dependencies without hidden state, misleading banners, or stranded readiness blockers.

## Current Blockers Found In Live Whataburger Testing

- Field dependencies are detected proactively, but selecting a field action can hide the rest of the field-resolution list while readiness remains blocked.
- Query-view and field dependency sync can overwrite each other because both update route-group state from the same stale route-group snapshot.
- The top status banner can say query-view mappings need attention even when the visible unresolved work is field and measure dependencies.
- The readiness panel blocks correctly, but it does not show enough dependency-type counts to explain what remains.
- Disabled actions, especially `Create from source`, need inline reasons so users understand whether they can create, map, or intentionally ignore.

## Desired End State

- Step 4 remains the authoritative dependency-resolution workspace.
- Field, query-view, topic, and relationship dependency sections remain visible after users make choices.
- Readiness sync preserves all dependency types from one preview result.
- The top message and readiness sidebar always match the visible unresolved work.
- Users can resolve, intentionally ignore, recheck readiness, and review without hidden blockers.
- The final migration should not be runnable until the compiled job input reflects those dependency choices.

## Phase 1: Stable Dependency State

- Persist detected field dependency rows separately from the transient preview plan.
- Keep field rows visible after `Map existing`, `Create from source`, or `Ignore`.
- Mark review data stale after dependency edits without hiding the dependency checklist.
- Preserve duplicate folder-route grouping so one decision set still applies to a shared target model.

Validation:

- A field action updates only that field row.
- Remaining unresolved field rows stay visible.
- The readiness blocker points to a visible row.

## Phase 2: Atomic Readiness Sync

- Merge query-view and field sync into one route-group update per readiness result.
- Preserve both `queryViewMappingsByTargetId` and field dependency/mapping state.
- Return a combined dependency summary for query views, fields, topics, and blockers.
- Prefer field-specific messaging when only field dependencies are unresolved and combined messaging when multiple types need attention.

Validation:

- A route with both query-view and field dependencies shows both sections.
- Query-view mappings are not lost when field mappings are added.
- The banner matches the visible unresolved dependency types.

## Phase 3: Resolution UX And Gating Polish

- Add dependency counts to the readiness sidebar.
- Show inline reasons for disabled actions.
- Keep ignored fields as warning-state choices, not blockers.
- Keep `Recheck readiness` disabled only while required choices remain unresolved.
- Ensure Step 5 only unlocks after readiness is rechecked with the selected dependency decisions.

Validation:

- Resolved and ignored field choices make the recheck button available.
- Unresolved field/query-view/topic choices keep the recheck button disabled.
- Review summarizes choices instead of showing stale warning dumps.

## Phase 4: Regression Coverage

- Add focused helper coverage for field dependency persistence.
- Add coverage that query-view and field sync results can coexist.
- Add preflight blocker coverage for unresolved field dependencies.
- Add review summary coverage for mapped, created, and ignored fields where useful.

Validation:

- `npm run test:dashboard-migration`
- `npm run typecheck`

## Phase 5: Human Browser Validation

Use the Whataburger route:

- Source: `ExploreOmni Environment` / `SE Demo - Food Service - PROD_FOOD_SERVICE`
- Dashboard: `WhataDashboard`
- Target: `SE Demo Environment` / `Food Service Demo - PROD_FOOD_SERVICE` / `food-service`

Validate:

- Step 4 shows field dependencies before import.
- Topic handling resolves to `WhataTopic` or presents a safe create/map choice.
- Query-view decisions appear when required and remain visible after edits.
- Field choices remain visible after one field is mapped or ignored.
- Recheck readiness only proceeds after choices are resolved.
- Stop before final Run unless explicitly approved.

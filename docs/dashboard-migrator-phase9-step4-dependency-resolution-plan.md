# Phase 9 — Step 4 Dependency Resolution: Requirements & Phased Plan

## Goal

A user arrives at Step 4 of the Dashboard Migrator, sees there are diffs, maps/adds/ignores them, and continues the dashboard migration with no errors.

## Baseline

Baseline: `main @ 5efe675`. The Advanced Code Diff Resolution plan (`docs/dashboard-migrator-advanced-code-review-plan.md`) is implemented and working: guided + code-review tabs, `semanticPatchesByTargetId` draft state, 4 resolutions (`recommended`, `custom_edit`, `keep_target`, `use_source`), patches applied at prep time with `previousChecksum`, gating via `semanticPatchValidationIssue`, and server preference for accepted patches with planner tests.

This plan closes the gap between "implemented" and "perfect UX."

## Current-State Gaps

- Arrival is blind: no rollup of what needs attention; readiness must be run manually, then lists scanned.
- No bulk actions, filters, or search; every artifact is resolved one-by-one.
- Code review renders plain `<pre>`/`textarea`; no line-level diff coloring.
- Destructive patches have no confirmation affordance; the flag blocks gating but nothing in the UI lets the user confirm; custom-editing after "Use source" muddies the confirmed state.
- Custom YAML edits are lost on reload because drafts intentionally strip YAML bodies; there is no warning or re-entry flow.
- Run-time prep failures are a dead end: item-log error, retry covers only export/import, no path back to Step 4.
- Decisions are shared within one destination model, but the same missing field on different target models requires separate resolutions.
- No virtualization/collapse/search at scale; large YAML in always-expanded cards.
- UI-level test coverage for the code-review behaviors is thin compared with planner-side coverage.

## Requirements

- **R1 — Arrive:** on entering Step 4, the user sees within one screen: total dependencies, broken down by artifact type × status (`auto-resolvable`, `needs decision`, `blocked`, `manual review`, `destructive-unconfirmed`), per destination-model group. Readiness runs automatically on step entry when inputs changed. If nothing needs resolution, an unmistakable "all clear — continue" state is shown.
- **R2 — See diffs:** source vs current vs proposed YAML is readable at a glance: line-level add/remove/change coloring, changed-regions-first for long files. No heavy editor dependency.
- **R3 — Resolve fast:** one-click "Apply all recommended" globally and per group; filter/search by status, artifact type, file, name; a decision made for one destination model can be offered to other destinations with the same gap.
- **R4 — Resolve safely:** destructive choices require an explicit in-context confirmation dialog; custom edits are validated non-empty; every blocked state names the artifact and offers the action that unblocks it in place.
- **R5 — Continue with no errors:** before the run, checksums are re-verified fresh and stale patches are one-click regenerated; users can optionally validate accepted patches against Omni before running; if a prep step still fails at run time, the item links back to Step 4 with the failing artifact focused, and retry covers prep + dependent imports.
- **R6 — Never lose work:** leaving/reloading with unsaved custom YAML warns the user; resumed drafts clearly mark custom edits that need re-entry, or preserve them in a safe store; decisions survive resume.
- **R7 — Non-negotiables preserved:** drafts never persist secrets; job-history sanitization unchanged; existing gating rules stay; security checks stay green; no main-branch model writes.

## Phase 9A — Arrival Clarity & Bulk Resolution

- Auto-run readiness on Step 4 entry when source, targets, groups, or options changed since the last check. Keep the button as "Re-check."
- Add a rollup banner at the top of Step 4: `N dependencies across M destination models — X auto-resolvable · Y need decisions · Z blocked · W manual review`.
- Make each count a click-to-filter chip.
- Add per-group status badges on every destination-model group header.
- Make groups collapsible and auto-collapse groups that are ready.
- Add global and per-group "Apply all recommended" actions that only apply safe recommendations.
- Add filter/search by status, artifact type, file, and name.
- Upgrade zero-dependency migrations to a clear all-clear state with a primary continue action.

Acceptance:

- Entering Step 4 with a prepared scenario immediately shows the rollup without clicks.
- One click resolves all safe items.
- A zero-dependency migration shows all-clear and continues.
- Group badges and filters reflect live state.

## Phase 9B — Readable Diffs

- Add `src/utils/lineDiff.ts`: a small LCS line differ producing `same`, `add`, and `remove` line records.
- Add a lightweight `DiffView` component with unified and side-by-side modes.
- Collapse unchanged runs by default and allow expansion.
- Add "Preview my edit as diff" for custom edits.
- Replace raw source/current/proposed `<pre>` blocks in Code review with diff views.
- Keep a plain-text toggle for copy/paste.

Acceptance:

- Long files show changed hunks first, not wall-to-wall YAML.
- Custom edits can be previewed as a diff before accepting.
- No new npm dependency.

## Phase 9C — Destructive & Custom-Edit Safety

- Clicking "Use source" on a patch with existing target YAML opens a confirmation dialog before setting `confirmedDestructive`.
- Blocked destructive messages include a "Review & confirm" action.
- Editing YAML after confirming a destructive patch resets `confirmedDestructive`.
- Keep raw YAML out of reusable drafts; warn before leaving/reloading when active custom YAML exists.
- On resume, a stripped custom edit renders as "Custom edit needs re-entry" and is blocked until the user re-enters or restores recommended YAML.
- Add consequence copy for action buttons.

Acceptance:

- Destructive source replacement always confirms.
- A blocked destructive patch is resolvable from the blocked message itself.
- Editing after confirming requires re-confirmation.
- Reload mid-edit warns, and resumed custom edits are clearly flagged.

## Phase 9D — No Errors At Run: Freshness, Validation, Remediation

- Re-fetch target YAML checksums before run for every accepted patch.
- Stale checksum mismatches produce a banner with affected artifacts and "Refresh & re-propose."
- Add optional "Validate patches before run" on Review.
- Branch-capable models validate against a scratch branch and delete the branch on success or failure; protected/main writes remain blocked.
- Non-branch models run structural checks only and label them clearly.
- Prep-kind failures in the run view get "Fix in Step 4" links that focus the artifact.
- Retry covers failed prep items and dependent imports.
- Prep errors are typed and user-readable.

Acceptance:

- Staleness between Step 4 and run is caught before run.
- Validation failures link back to the artifact in Step 4.
- Runtime prep failures can be fixed and retried without restarting the whole migration.

## Phase 9E — Scale, Cross-Destination Reuse & Polish

- Offer "Apply this decision to N other destinations" when compatible destinations have the same source artifact gap.
- Never auto-apply destructive decisions; queue each for confirmation.
- Collapse groups by default beyond roughly 10 artifacts.
- Lazy-render YAML/diff bodies on expand.
- Add accessibility polish: tablist roles, context-rich button labels, `aria-live` status banners, glyphs in diff lines.
- Update walkthrough and README.
- Add wizard-level tests for code-review exposure, custom edit, keep target, gating, and draft redaction.

Acceptance:

- A 60-artifact scenario stays responsive and navigable.
- Same-field-everywhere resolves quickly with confirmations.
- Keyboard-only flow can complete Step 4.
- Test coverage protects the original code-review requirements.

## Phase Gates

For every phase, run as much of the gate as is practical for the changed surface:

- `npm run test:dashboard-migration`
- `npm run test:migration-planner`
- `npm run test:security`
- `npm run typecheck`
- `npm run typecheck:node`
- `npm run build`
- `npm run lint`
- `git diff --check`

## Implementation Note

The Phase 9D scratch-branch validation bullet is intentionally not implemented in this iteration. The server client has branch create/update/validate primitives, but the safe branch deletion path currently exists only as part of merge operations. Dashboard Migrator should not create throwaway branches it cannot confidently clean up, and it should not merge as a cleanup mechanism. Instead, this iteration adds a pre-run Omni readiness/freshness validation that re-fetches target YAML/checksums, blocks stale accepted patches before job creation, and routes users back to Step 4 for repair.

## Implementation Status

- [x] Phase 9A — Arrival clarity & bulk resolution
  - Added Step 4 dependency rollups, filters, per-destination summaries, collapsible groups, zero-dependency all-clear copy, and global/per-group safe recommendation actions.
  - Added automatic readiness checks on Step 4 entry when route inputs change.
- [x] Phase 9B — Readable diffs
  - Added `src/utils/lineDiff.ts` and `DiffView` with unified, side-by-side, and plain-text modes.
  - Replaced raw code-review YAML blocks with changed-region diff previews and retained copy/paste access.
- [x] Phase 9C — Destructive & custom-edit safety
  - Added in-context destructive confirmation, reset confirmation on custom YAML edits, blocked empty custom edits, and before-unload warnings for active custom YAML.
  - Kept raw YAML out of reusable drafts and marked stripped custom edits as blocked with re-entry guidance.
- [x] Phase 9D — Freshness, validation, and remediation
  - Planner now marks accepted semantic patches stale when target checksums change, blocks affected prep/import steps, and surfaces latest checksum metadata.
  - Review can recheck dependency freshness before run, stale code cards can refresh/apply latest recommendations, and failed prep items link back to Step 4 with filters focused.
- [x] Phase 9E — Scale, reuse, polish, docs, and tests
  - Added compatible non-destructive code-decision reuse, large/ready group auto-collapse, diff tab accessibility roles, README/walkthrough updates, and stale-check/security regression coverage.

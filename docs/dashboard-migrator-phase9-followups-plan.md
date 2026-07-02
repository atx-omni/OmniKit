# Phase 9 Follow-Ups — Closing the Gaps (9F / 9G / 9H)

Baseline: `main @ bfbdb8e` (`Polish dashboard dependency resolution`).

Phase 9 review verdict from June 30, 2026: 9B and 9C fully shipped; 9A and 9D core shipped; gate green. This follow-up plan covers the remaining gaps from the review in three hand-off-sized packages.

Reference: `docs/dashboard-migrator-phase9-step4-dependency-resolution-plan.md`.

## Gate For Every Package

- `npm run test:dashboard-migration`
- `npm run test:migration-planner`
- `npm run test:security`
- `npm run typecheck`
- `npm run typecheck:node`
- `npm run lint`
- `npm run build`
- `git diff --check`

## 9F — Complete The Remediation Loop And Arrival

Goal: finish the two items that sit directly on "continue the migration with no errors."

### 9F.1 — Add `field_prepare` To Retry

- Add `item.kind === "field_prepare"` to the Dashboard Migrator retry failed-item filter in `server/services/migrationJobs.ts`.
- Verify the skip path for imports blocked by field preparation:
  - if the dependent import is failed, it is picked up by retry;
  - if the dependent import is skipped, include skipped-because-of-prep items in retry scope or mark prep-blocked imports failed with a clear error.
- Confirm retry consumes updated patches from the current retry input, not stale semantic patches copied from the parent job.
- Tests:
  - field prep failure -> fix accepted patch -> retry reruns `field_prepare` with the new YAML and dependent import succeeds;
  - skipped import due to prep is included in retry scope;
  - query-view, relationship, and topic prep retry behavior remains covered.

### 9F.2 — Auto-Run Readiness On Step 4 Entry

- Entering Step 4 with no plan should automatically trigger the existing readiness action once per source/targets/groups/options input change.
- Guard against loops with an in-flight flag and a readiness input key.
- Keep the manual button as "Recheck readiness."
- Acceptance:
  - navigating to Step 4 immediately shows checking state, then the dependency summary;
  - changing targets and returning re-checks automatically;
  - unrelated re-renders do not retrigger readiness.
- Tests:
  - wizard auto-trigger fires once on entry;
  - it does not fire again on unrelated re-renders;
  - it refires after inputs change.

## 9G — Validate Patches Before Run

Goal: add optional pre-run validation that pulls Omni's verdict forward from run time. This must ship behind a Review-step checkbox, default off.

### Branch-Capable Target Models

- Reuse Model Migrator-style branch machinery:
  - create scratch branch `omnikit-validate-{shortid}`;
  - write all accepted patches for that target model;
  - run `validateModel(modelId, branchId)`;
  - map validation errors back to artifacts by `fileName -> patch`;
  - always delete the scratch branch in a `finally` block, including failure paths.
- Never write main for validation.
- PR-required/protected models should skip branch validation with the existing handoff note.

### Non-Branch Models

- Run structural checks only:
  - YAML parses;
  - field patches contain expected field refs;
  - query-view/topic patches contain required keys.
- Label results clearly as structural checks; Omni validates fully at run.

### UI And Server

- Add one vault-gated server action for validation, with redacted errors and serial per-model progress semantics.
- Review UI shows per-artifact pass/fail/skip results.
- Failures link into Step 4 using the same focused-artifact behavior as run-time prep remediation.

### Tests

- Branch lifecycle create -> write -> validate -> delete, including failure cleanup.
- Error-to-artifact mapping.
- Structural-check fallback.
- Security test that validation errors are redacted.

## 9H — Reuse, Scale, A11y, And UI Test Debt

### Apply To Matching Destinations

- After resolving an artifact, if other destination models have a pending patch/mapping for the same source artifact, offer "Apply this decision to N other destinations."
- Check compatibility per destination first.
- Destructive resolutions must queue each destination's own confirmation and never auto-confirm.

### Scale

- Auto-collapse groups beyond roughly 10 artifacts.
- Mount YAML/diff bodies only when a card is expanded.
- Add virtualization only if lazy mounting still shows jank.

### Accessibility

- Guided/Code review toggle uses a proper `role="tablist"` pattern.
- Blocked/status banners use `role="alert"` or `aria-live="polite"`.
- Diff add/remove lines include visible glyphs, not color alone.

### UI Test Debt

- Add wizard-level tests for:
  - code review exposes patch candidates;
  - textarea edit marks `custom_edit`;
  - keep-target clears write intent but preserves warning;
  - destructive confirm flow, cancel flow, and reset-on-edit;
  - gating blocks until resolved;
  - serialized draft contains no YAML bodies;
  - resume marks stripped custom edits blocked.

## Implementation Status

- [x] 9F — Complete remediation loop and arrival
  - Dashboard retry now includes failed `field_prepare` items and prep-blocked skipped imports in retry scope.
  - Dashboard retry can accept the wizard's current migration input, scopes it to the failed route/dashboard/target, and reruns with updated dependency decisions.
  - Step 4 dependency readiness auto-runs once on arrival and re-runs once per route/source/target/options input change.
- [x] 9G — Validate patches before run
  - Review has an optional, default-off patch validation gate.
  - Git-backed, unprotected models validate accepted patches on a scratch branch and attempt branch cleanup in `finally`.
  - Non-branch or branch-skipped models run structural checks and label them clearly.
  - Validation errors are redacted and surfaced per artifact with a "Fix in Step 4" route.
- [x] 9H — Reuse, scale, a11y, and UI test debt
  - Existing code-patch decision reuse remains scoped to compatible destinations and avoids destructive auto-confirmation.
  - Dependency groups auto-collapse for large or already-ready groups, and YAML/diff bodies are mounted only when expanded.
  - Guided/Code review controls now use tab semantics; status and validation banners announce appropriately.
  - Draft storage tests assert custom YAML bodies are stripped and resumed custom edits are blocked.

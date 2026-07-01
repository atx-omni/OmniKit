# Deck Builder Native Visual Review Plan

## Requirements

- Let users preview the query behind each selected dashboard tile before final deck preview.
- Keep the default path simple: native visual mode should default to `Auto`, which preserves OmniKit's current inferred render behavior.
- Allow users to choose the native visual type for each tile when using Native output:
  - Auto
  - Table
  - Bar chart
  - Line chart
  - Pie chart
  - KPI
- Store visual choices in deck recipes so saved vault recipes and JSON recipe import/export reproduce the same deck.
- Use the same effective visual decision in live preview and generated PowerPoint output.
- Show readable query summaries by default instead of raw JSON.
- Keep advanced raw query JSON available behind an explicit details/advanced view.
- Disable or warn on incompatible native visual choices, using clear user-facing language.
- Avoid storing secrets, raw API responses, generated files, preview images, or transient export state in recipes.

## Phase 1: Data Model And Recipe Persistence

Plan:
- Add a `NativeVisualOverride` type.
- Add `nativeVisualOverrides` to `DeckRecipe`.
- Update recipe build, validation, draft resume/load, and save/load paths.
- Ensure older recipes without this field still load.

Validation:
- Existing recipes remain compatible.
- New recipes can persist per-tile native visual choices.
- Recipe sanitization continues to reject or strip unsafe secret-shaped content.

## Phase 2: Query Summary Layer

Plan:
- Add a helper that turns `DashboardTile.rawQuery` into a readable query summary.
- Include model, topic, selected fields, filters, sorts, limit, and query source path where available.
- Provide a safe advanced JSON formatter for explicit inspection.
- Treat markdown and unsupported tiles as clear non-query cases.

Validation:
- Normal Omni tiles show readable query summaries.
- Missing/unsupported query payloads do not throw in the UI.
- Query previews do not expose API keys or session secrets.

## Phase 3: Native Visual Compatibility Rules

Plan:
- Add compatibility rules for `auto`, `table`, `bar`, `line`, `pie`, and `kpi`.
- Add helpers to resolve the effective render kind from detected result plus user override.
- Keep `table` and `auto` broadly available; constrain chart/KPI options based on result shape.

Validation:
- Incompatible visual choices are disabled with helpful explanations.
- `auto` preserves existing inferred `renderKind`.
- Manual overrides only affect Native output.

## Phase 4: Visual Review UI

Plan:
- Insert a new `Output` wizard step after tile selection.
- For each selected tile, show:
  - source choice as the primary decision
  - query summary
  - detected/native render status when available
  - native visual selector
  - render action for that tile
- Keep a short default explanation for non-technical analysts.

Validation:
- Users can review all selected tiles before final slide layout.
- Native-compatible tiles expose visual choices.
- Image/full-dashboard/skipped tiles clearly explain that visual overrides do not apply.
- The step does not imply PowerPoint-native output is the only visual source; Omni PNG and dashboard PNG are visible first-class choices.

## Phase 5: Preview And PPTX Parity

Plan:
- Pass native visual overrides into preview rendering and PPTX generation.
- Use one effective render decision for preview and export.
- Update export/readiness labels so users see Auto vs custom visual decisions.

Validation:
- Preview and generated PPTX match for forced table/bar/line/pie/KPI choices.
- A detected table can be forced to a compatible chart.
- A recipe-loaded override renders the same way after reload.

## Phase 6: Recipe And Workflow Polish

Plan:
- Add recipe library badges/counts for customized native visuals.
- Include native visual choices in exported recipe JSON.
- Improve labels in Generate so customized native visuals are easy to spot.

Validation:
- Save/load/export/import preserves native visual choices.
- Recipe library communicates when a recipe has customized native visuals.

## Phase 7: Test And Live Smoke

Plan:
- Add tests for:
  - query summary generation
  - compatibility rules
  - recipe validation with native visual overrides
  - preview/export effective render kind
- Run the existing Deck Builder, security, typecheck, lint, and build checks.
- Smoke test Coffee Shop Demo:
  - Sales by Hour Auto renders as bar.
  - Force table and confirm preview/export table.
  - Force bar and confirm preview/export bar.
  - Save/load recipe and confirm the override persists.

Validation:
- Automated checks pass.
- Live browser behavior matches the requirements above.

## Implementation Validation Log

- Phase 1 complete: `NativeVisualOverride` and `nativeVisualOverrides` are part of the recipe and draft contracts, with `auto` treated as the default.
- Phase 2 complete: `querySummary.ts` provides readable query previews plus redacted advanced JSON.
- Phase 3 complete: `nativeVisuals.ts` provides compatibility rules and effective render-kind resolution.
- Phase 4 complete: Deck Builder includes an `Output` step after tile selection with query preview, source choice, render action, and native visual choice controls.
- Phase 4 UX refinement complete: the step is now framed as `Output`, source choices are visible first-class controls, and native PowerPoint chart controls are clearly nested under the Native output path.
- Phase 4 retry/preview refinement complete: native visual choices remain selectable after rendering so users can switch and retry without returning to Auto; rendered outputs now appear directly in the Output step; resumed drafts refresh dashboard query data from Omni before entering the workflow so sanitized draft tiles do not falsely appear unsupported.
- Phase 4 render-workspace refinement complete: Step 3 always shows a rendered-output surface, including a not-yet-rendered placeholder, and the all-tile action is labeled as rendering outputs so the later Preview step can stay focused on deck review.
- Phase 5 complete: slide preview, single PPTX generation, batch generation, and run-status labels use the effective native visual decision.
- Phase 6 complete: recipe cards and Generate review show customized native visual choices.
- Phase 7 automated validation complete:
  - `npm run test:deck-builder`
  - `npm run test:security`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`
  - `npm run lint` passed with existing Fast Refresh warnings only
  - `git diff --check`

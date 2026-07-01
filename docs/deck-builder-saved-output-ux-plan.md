# Deck Builder Saved Output UX Plan

## Summary

This pass optimizes Deck Builder for three user journeys:

- creating a PowerPoint with editable native PowerPoint visuals
- creating a PowerPoint with Omni-rendered PNG visuals
- continuing from a saved draft or saved vault recipe

The goal is to make the workflow feel like a guided deck-building experience, not a configuration engine. Users should always understand where they are, what output each slide will use, whether each slide is ready, and when they should review output choices before moving to deck layout.

## Original Requirements

- Saved drafts and vault recipes must be easy to continue from without bypassing important output choices.
- A returning user should know whether they are reviewing a deck or still configuring visual output.
- Native editable output should clearly support choosing and retrying visual types.
- Omni PNG and Dashboard PNG should feel like first-class output choices, not fallbacks hidden behind native PowerPoint behavior.
- The Output step should make source-specific rendering obvious:
  - Native output previews editable chart/table/KPI decisions.
  - Omni PNG previews Omni's exact rendered tile image.
  - Dashboard PNG previews the full dashboard screenshot source.
- The Preview step should remain focused on final deck layout, insight text, speaker notes, and callouts.
- Slide-level status should be easy to scan:
  - needs render
  - ready
  - native visual type ready
  - Omni PNG ready
  - Dashboard PNG ready
  - skipped
- Render actions should use user-friendly, source-aware language.
- Query/details copy should not imply a user is configuring native output after they selected an Omni or dashboard image source.

## Phase 1: Save Requirements And Validation Plan

Plan:
- Save this document as the reference requirements file.
- Use it as the comparison point after each phase.

Validation:
- Requirements are explicit enough to validate implementation against.

Status:
- Complete.

## Phase 2: Saved Draft And Recipe Continuation

Plan:
- Add a returning-user notice after loading a saved draft or vault recipe.
- Offer clear actions:
  - review output choices
  - continue preview
- Route saved vault recipes with selected tiles to the Output step by default, because preview images are not persisted.
- Keep session drafts on their saved step, but show the notice when users resume into later steps.

Validation:
- Resuming a draft makes the current workflow state explicit.
- Loading a recipe does not skip the Output step silently.
- Users can still continue straight to Preview when that is their intent.

## Phase 3: Output Status And Render Language

Plan:
- Replace generic output labels with shared Deck Builder output status helpers.
- Use source-aware render button text:
  - Render native visual
  - Render Omni PNG
  - Render dashboard PNG
  - Skipped
- Rename the selected output hero from "Rendered output" to "Output preview".
- Replace "Not rendered" with "Needs render".
- Add clearer empty state copy for unrendered slides.

Validation:
- The slide rail and selected slide header agree on readiness.
- A user can understand what pressing the render button will produce.
- The output hero no longer combines "Rendered output" with "Not rendered".

## Phase 4: Source-Aware Details

Plan:
- Keep query metadata available, but change its label and helper text by selected output source.
- Native output shows "Native query preview".
- Omni PNG output shows "Omni image source details".
- Dashboard PNG output shows "Dashboard screenshot source".
- Skipped output shows "Skipped slide details".

Validation:
- Omni PNG and Dashboard PNG users do not see native-only language as the primary detail label.
- Technical query data remains available for troubleshooting.

## Phase 5: Final Validation

Plan:
- Run:
  - `npm run test:deck-builder`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`
  - `git diff --check`
- Do a live browser smoke pass if the local app remains available:
  - resume a draft
  - review the Output step
  - render a native visual
  - switch to Omni PNG
  - confirm Preview remains layout-focused

Validation:
- Automated checks pass.
- Browser behavior matches this requirements document.

## Implementation Validation Log

- Phase 1 complete: requirements saved in this file.
- Phase 2 complete: vault recipe loads now route valid saved recipes to Output, and resumed drafts/saved recipes show a returning-user notice with actions to review output choices or continue preview.
- Phase 3 complete: Output uses shared source-aware helpers for slide rail readiness, selected-slide summary, and render button labels. Empty output preview copy now says the slide needs a render instead of pairing "Rendered output" with "Not rendered".
- Phase 4 complete: Query details now use source-aware labels and helper copy for Native, Omni PNG, Dashboard PNG, and skipped slides while keeping technical query metadata available.
- Phase 5 complete: `npm run test:deck-builder`, `npm run typecheck`, `npm run typecheck:node`, `npm run build`, `npm run lint`, and `git diff --check` passed. Lint reported only existing Fast Refresh warnings in shared UI/context files. Live browser smoke confirmed saved draft resume notice, Output rail `Needs render` statuses, `Render native visual`, Omni PNG source-aware copy, and restore-to-native behavior.

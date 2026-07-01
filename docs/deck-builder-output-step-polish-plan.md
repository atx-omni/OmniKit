# Deck Builder Output Step Polish Plan

## Summary

Step 3 in Deck Builder is functionally powerful, but it currently feels like a repeated developer configuration form. The next iteration should make it feel like a polished visual output workspace:

- users pick one slide at a time
- the rendered output is the primary focus
- Native, Omni PNG, Dashboard PNG, and Skip are clearly first-class options
- query metadata is available without dominating the page
- the final Preview step remains focused on deck layout review

## Requirements

- Replace the repeated full-card stack with a two-panel layout:
  - left slide rail with compact status rows
  - right selected-slide workspace
- Only one tile should be expanded at a time.
- Keep all existing state, recipe, render, and PPTX contracts intact.
- Make the selected slide's rendered output the hero area.
- Show an empty/not-rendered state before a render runs.
- Keep render actions close to the preview:
  - render selected slide
  - render all outputs
  - use Omni PNG instead when useful
  - reset Native visual type to Auto when customized
- Replace large stacked output-source cards with a compact selector using icons and stronger selected states.
- Show Native visual type controls only when Native output is selected.
- Native visual controls must remain retry-friendly:
  - Auto
  - Table
  - Bar
  - Line
  - Pie
  - KPI
- Replace confusing status combinations with a single friendly output summary.
- Move model/topic/fields/filters/sorts into a collapsible Query details area.
- Move Advanced query JSON behind a nested Technical details disclosure.
- Fix stepper clipping on narrower widths.
- Preserve support for:
  - per-tile visual source choices
  - per-tile native visual overrides
  - rendered native previews
  - Omni PNG / dashboard PNG previews
  - Skip
  - recipe save/load/export/import
  - final Preview and PPTX generation parity

## Phase 1: Component And Layout Restructure

Plan:
- Extract Step 3 into a dedicated `DeckOutputStep` component.
- Use a two-panel layout:
  - compact slide list/rail
  - selected slide workspace
- Track an active output tile ID in `DeckBuilderPage`.
- Default active tile to the first selected tile.

Validation:
- Step 3 renders through the new component.
- Selecting a slide in the rail updates the workspace.
- Existing per-tile state is unchanged.

## Phase 2: Preview-First Workspace

Plan:
- Move rendered output to the top of the selected slide workspace.
- Show a clear placeholder before render.
- Keep selected-slide render action next to the output area.
- Keep render-all available at the step level.

Validation:
- Users can see the selected output result without scrolling through query metadata first.
- Before rendering, the selected slide has a polished empty state.

## Phase 3: Output Source And Native Visual Polish

Plan:
- Replace stacked source cards with compact option tiles using icons.
- Make selected state visually clear.
- Keep Omni PNG and Dashboard PNG as peer options, not hidden fallback concepts.
- Show Native visual controls only under Native output.
- Keep incompatible visual choices selectable for retry, with friendly helper text.

Validation:
- Source choices feel like one clear decision.
- Native visual retry does not require resetting to Auto.
- Non-native sources hide Native-specific controls.

## Phase 4: Query Metadata Progressive Disclosure

Plan:
- Collapse query metadata into `Query details`.
- Summarize query status in one line near the controls.
- Keep Advanced query JSON nested under `Technical details`.

Validation:
- The default surface is visual-first.
- Technical/debug information remains accessible.
- Advanced JSON no longer repeats as prominent content for every slide.

## Phase 5: Stepper And Responsive Polish

Plan:
- Allow the wizard stepper to wrap/scroll cleanly without clipping labels.
- Ensure the slide rail and workspace stack cleanly on smaller screens.
- Keep buttons and text readable at common laptop widths.

Validation:
- Generate step is not clipped.
- The output step remains usable on narrow desktop viewports.

## Phase 6: Validation

Plan:
- Run:
  - `npm run test:deck-builder`
  - `npm run typecheck`
  - `npm run build`
  - `git diff --check`
- Do a live browser smoke pass:
  - select several slides in the rail
  - render a Native output
  - change Native type and retry
  - switch to Omni PNG
  - confirm final Preview remains a layout review step

Validation:
- Automated checks pass.
- Live UI behavior matches the requirements above.

## Implementation Validation Log

- Phase 1 complete: Step 3 was extracted into `DeckOutputStep` with a compact slide rail and one selected-slide workspace. `DeckBuilderPage` remains the workflow/state coordinator.
- Phase 2 complete: the selected slide workspace is preview-first, with a persistent rendered-output hero area, empty state, render-selected action, render-all action, and contextual Omni PNG recovery action.
- Phase 3 complete: output source choices are compact icon tiles; Native-specific controls only appear for Native output; custom Native visual choices remain retry-friendly and can reset to Auto.
- Phase 4 complete: query metadata is collapsed into `Query details`, and raw query JSON is nested under `Technical details`.
- Phase 5 complete: the wizard stepper now wraps in a responsive grid and avoids clipping the Generate step on the reviewed viewport.
- Live smoke complete: resumed the Coffee Shop draft, selected Sales by Hour from the slide rail, switched between Native and Omni PNG, selected Line chart without resetting to Auto, and confirmed the rendered Native output updates in Step 3.
- Follow-up polish complete: Output now comes after Branding, and the Output step's primary Continue action advances through selected slides before moving to final Preview.
- Automated validation complete:
  - `npm run test:deck-builder`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`
  - `npm run lint` passed with existing Fast Refresh warnings only
  - `npm run test:security`
  - `git diff --check`

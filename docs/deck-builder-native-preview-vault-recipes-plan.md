# Deck Builder Native Preview + Vault Recipe Requirements

## Summary

- The live Deck Builder slide preview should match the final generated PowerPoint output for Native visuals.
- Native preview currently renders native query results as tables when the final PPTX can render the same result as a chart.
- Saved Deck Builder recipes should move from browser-only localStorage to the native encrypted vault, while JSON import/export remains available.

## Native Preview Parity

- Treat `TileResult.renderKind` as authoritative for native preview rendering:
  - `kpi`
  - `bar`
  - `line`
  - `pie`
  - `table`
  - `markdown`
  - `empty`
  - `unsupported`
- Remove preview-only behavior that forces results with more than 3 columns to render as tables.
- Keep preview chart/table assumptions aligned with the generated PPTX renderer.
- Show a visible preview detail such as render kind, row count, and column count.

## User-Friendly Render Controls

- Keep Native as the default mode for editable PowerPoint output.
- Clarify render source descriptions:
  - Native: editable PowerPoint chart/table when OmniKit can translate the query.
  - Omni image: exact Omni-rendered visual, not editable.
  - Full dashboard: fallback screenshot.
- Add a per-slide recovery action to switch to Omni image when native preview fails, is unsupported, or appears as a table when the user expected a chart.

## Vault-Backed Recipes

- Extend native vault payload with `deckRecipes`, defaulting to an empty array for existing vaults.
- Add local server API routes under `/api/deck-recipes` for:
  - list
  - save/update
  - duplicate
  - rename
  - delete
  - export payload
- Persist recipe metadata and the existing `DeckRecipe` payload.
- Continue rejecting or stripping secret-shaped keys before saving recipes.
- Keep JSON recipe import/export.
- Add a one-time import path from existing browser localStorage recipes into the vault.
- Update Deck Builder to use the vault-backed recipe API when the vault is unlocked.
- Show a clear locked-vault state when recipe library actions require unlock.

## PowerPoint Customization Foundation

- Preserve existing recipe customization fields:
  - selected tiles
  - visual source per tile
  - layout boxes
  - insight text
  - speaker notes
  - callouts
  - filters
  - batch setup
  - brand
  - template
- Add or preserve metadata fields:
  - `name`
  - `description`
  - `savedForInstanceId`
  - `savedForInstanceLabel`
  - `savedForBaseUrlHost`
  - `createdAt`
  - `updatedAt`
- Do not store API keys, active session tokens, generated PPTX blobs, preview PNGs, raw API responses, or transient export states.

## Test Plan

- Add Deck Builder tests for preview classification:
  - Native result with 4 columns and `renderKind: "bar"` previews as a chart, not a table.
  - `renderKind: "table"` previews as a table.
  - `pngDataUrl` image previews override structured native results.
- Add recipe vault tests:
  - Existing vaults without `deckRecipes` load successfully.
  - Save/list/rename/duplicate/delete recipe operations persist encrypted vault payload changes.
  - Secret-shaped keys are stripped or rejected before recipe persistence.
  - Locked vault returns 423 for recipe API calls.
- Add or perform workflow smoke checks:
  - Coffee Shop Demo `Sales by Hour` in Native mode renders a chart in preview and generated PPTX.
  - Switching the same slide to Omni image shows image preview and exports as image.
  - Save recipe to vault, reload app, unlock vault, load recipe, generate the same deck.
- Run validation:
  - `npm run test:deck-builder`
  - `npm run test:security`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`

## Assumptions

- Native means matching generated editable PowerPoint output, not exact Omni browser visualization.
- Recipes are vault-backed by default.
- Browser localStorage is retained only for legacy recipe import/export compatibility.
- The existing dashboard tile export APIs should remain unchanged.

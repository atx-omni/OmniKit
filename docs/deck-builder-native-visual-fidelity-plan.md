# Deck Builder Native Visual Fidelity Requirements

## Summary

- Native PowerPoint output should no longer feel like a generic chart reconstruction when OmniKit has enough information to produce a better editable visual.
- Exact editable Omni parity depends on whether Omni exposes saved tile visualization metadata.
- OmniKit should support a durable middle path: extract Omni visual metadata when available, infer safe defaults when it is not available, let users tune mappings, and keep Omni PNG as the exact-fidelity fallback.

## Phase 0: Visual Spec Discovery

- Inspect raw tile payloads from `/v1/documents/{dashboardId}/queries`.
- Look for visual metadata keys such as:
  - `queryPresentation`
  - `vis_config`
  - `visConfig`
  - `visualization`
  - `display`
  - `chart`
  - `encoding`
  - `mark`
- Classify whether visual metadata is:
  - high confidence from Omni metadata
  - medium confidence from query/result inference
  - manual from user configuration
  - unsupported
- Preserve the decision gate:
  - if Omni metadata exists, seed native mappings from it
  - if not, expose user mapping controls and recommend Omni PNG for exact fidelity

## Phase 1: TileVisualSpec Contract

- Add a normalized `TileVisualSpec` type with:
  - source: `omni`, `inferred`, or `user`
  - confidence
  - render kind
  - category field
  - measure fields
  - optional series field
  - optional sort
  - optional limit/top N
  - optional number format
  - optional color palette
  - warnings
- Add extractor helpers to pull possible visual metadata out of raw Omni tile payloads.
- Add inference helpers to resolve a usable mapping from result columns/rows when Omni metadata is incomplete.

## Phase 2: Persistence And Export Contract

- Add visual specs to deck recipes and autosaved drafts.
- Preserve backward compatibility with existing `nativeVisualOverrides`.
- Do not persist raw tile payloads, preview image data, generated PPTX blobs, secrets, tokens, API keys, or transient query results.
- Pass visual specs into batch export and PPTX generation.

## Phase 3: Shared Preview And PPTX Mapping

- Replace duplicate first-dimension/first-measure heuristics with shared visual mapping helpers.
- Ensure preview and generated PPTX use the same:
  - chart type
  - category field
  - measure fields
  - series grouping when possible
  - sorting/limit behavior
  - labels
  - number formatting
  - colors
- Keep table, KPI, markdown, empty, unsupported, and PNG behavior intact.

## Phase 4: User Controls And Fidelity Messaging

- Update Deck Builder Output controls so Native is clearly positioned as editable PowerPoint output.
- Show confidence/status messaging:
  - matched Omni visual metadata
  - inferred from query result
  - user customized
  - unsupported or low confidence
- Let users tune native mappings:
  - chart type
  - category field
  - measure fields
  - optional series field
  - sort
  - top N
  - number format
- Keep Omni PNG as the exact visual fidelity recovery path.

## Phase 5: PowerPoint Renderer Upgrade

- Improve native chart styling:
  - brand palette
  - clearer axes
  - legends
  - better font sizing
  - cleaner gridlines
  - labels and compact value formatting
- Support improved multi-measure bar/line charts.
- Keep unsupported shapes safe by falling back to table or Omni PNG guidance.

## Phase 6: Tests And Validation

- Add tests for:
  - Omni visual metadata extraction
  - inference fallback
  - user mapping persistence in recipes
  - draft save/load without secrets
  - PPTX chart generation from explicit mapping
  - preview/PPTX mapping parity helpers
- Run:
  - `npm run test:deck-builder`
  - `npm run typecheck`
  - `npm run typecheck:node`
  - `npm run build`

## Implementation Status

- Phase 0: Complete - raw tile payload visual metadata discovery is handled by `findVisualMetadataCandidates` and `extractTileVisualSpecFromRaw`.
- Phase 1: Complete - `TileVisualSpec` and mapping helpers were added for Omni metadata, inferred mappings, and user mappings.
- Phase 2: Complete - visual specs are persisted through recipes, autosaved drafts, batch runs, and PPTX generation without raw payloads or secrets.
- Phase 3: Complete - preview and PPTX generation now share `resolveVisualMapping` for render kind, fields, sort/limit, labels, and colors.
- Phase 4: Complete - Output controls now explain editable PowerPoint output, show confidence, and allow chart/category/measure/series/sort/top-N/format tuning.
- Phase 5: Complete - native PPTX charts now use the resolved mapping, brand palette, legends, axis fonts, and multi-measure/series handling.
- Phase 6: Complete - validation added for metadata extraction, inference, persistence, draft safety, PPTX generation, and mapping parity.

## Validation Results

- `npm run typecheck` - passed
- `npm run test:deck-builder` - passed, 21 tests
- `npm run typecheck:node` - passed
- `npm run build` - passed; Vite reported the existing large chunk / JSZip mixed import warnings
- `npm run lint` - passed with existing Fast Refresh warnings in shared UI/context modules
- `git diff --check` - passed

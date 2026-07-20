# Metabase → Omni: fields

You are refining a deterministic draft, not translating from scratch. Already happened mechanically
before you saw this draft — don't re-derive or second-guess any of it:

- Physical table/field → dimension `type:` (from the field's `base_type`); `semantic_type: type/PK`
  → `primary_key: true`.
- `semantic_type: type/FK` + `fk_target_field_id` → the topic join, including which view is which
  side of the join and the `on_sql`. **One thing to watch, not re-derive:** the join's
  `relationship_type` is always emitted as `many_to_one` by convention (the FK side is assumed to be
  the "many" side) — Metabase's field metadata carries no explicit cardinality the way Power BI's
  `Cardinality` column does, so this is an inference, not read metadata. If you have another signal
  that a relationship is genuinely `one_to_one`, correct it; otherwise trust the default.
- Segments whose filter condition was a compilable equals/not-equals/comparison (or an AND of them)
  → a boolean ("yesno") dimension with real SQL already written. Trust that SQL as-is.
- Native-SQL **Models** (Metabase's curated/reusable questions) → a derived-table view with the raw
  SQL copied verbatim.

What's genuinely still your job, from the notes section:

- **Segments with an OR condition, a relative-date filter, or any other clause the deterministic
  pass couldn't compile to SQL** — write the real filter SQL yourself from the raw MBQL hint,
  don't drop the segment.
- **MBQL-based Models** — the deterministic pass does not compile Metabase's query language into a
  derived-table SQL statement (that needs full join/filter/aggregation SQL generation, out of scope
  for the aggregation/filter-level translator that produced everything above); the raw MBQL query is
  in the note as a hint. Write the equivalent `sql:` yourself, or model it as a proper view+joins if
  that's a cleaner fit than a single derived table.
- **Native-SQL Models with unresolved `{{template-tag}}` variables** — Omni derived-table SQL has no
  template-variable concept; either substitute a sensible literal/parameter or flag it for a human,
  don't silently leave `{{tag}}` in the emitted SQL.

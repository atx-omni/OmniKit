# Tableau → Omni: fields

You are refining a deterministic draft, not translating from scratch. Already happened mechanically
before you saw this draft — don't re-derive or second-guess any of it:

- Dimension vs. measure classification (from each column's Tableau `role`) and the dimension `type:`
  (from its Tableau datatype).
- Calculated-field classification: a clean `SUM(...)`/`AVG(...)`/`COUNTD(...)`/etc. wrapper around a
  resolvable reference became a measure with that `aggregate_type`; a non-aggregate formula with every
  `[Ref]` resolved became a dimension.
- `[Ref]` resolution to physical columns. Every reference that couldn't be resolved (LOD expressions,
  nested aggregates, unknown fields) was already excluded from the draft — it's in the notes section
  below instead, not silently dropped or guessed at.

One thing in the draft is a **default, not a derived fact** — call it out if you see it in the notes:
a plain `role="measure"` column has no intrinsic aggregation in Tableau's own metadata (unlike a
LookML measure's `type:`), so it defaults to `sum`. If the field's name or description suggests
otherwise (e.g. an average, a count, a rate), correct it; otherwise leave it.

For what's actually flagged in the notes section (LOD expressions, nested aggregates, unresolved
refs): a Level-of-Detail expression usually has no direct Omni equivalent — if you can confidently
rewrite the intent as a window function or a join to a pre-aggregated view, do so; otherwise leave a
clear YAML comment explaining what's missing rather than dropping the field.

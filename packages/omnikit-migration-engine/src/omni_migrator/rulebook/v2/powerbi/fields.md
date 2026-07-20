# Power BI → Omni: fields

You are refining a deterministic draft, not translating from scratch. Already happened mechanically
before you saw this draft — don't re-derive or second-guess any of it:

- Physical column → dimension `type:` (from the column's VertiPaq data type).
- DAX measure → measure: a clean single-table aggregate wrapper (`SUM`/`AVERAGE`/`MIN`/`MAX`/`MEDIAN`/
  `DISTINCTCOUNT`/`COUNT`/`COUNTROWS` over a column on the measure's own table, nothing nested) was
  translated to that `aggregate_type` deterministically — trust it. A measure only reaches you as a
  field when this succeeded; anything else (`CALCULATE`, time intelligence, iterators, cross-table
  refs, implicit report-time aggregates) was deliberately left untranslated rather than guessed — it's
  in the notes section with the original DAX as a hint, not silently dropped.
- Relationships → topic joins, including the join direction and `relationship_type` (from Power BI's
  own cardinality metadata) — trust the direction/type as given.

The target connection **dialect** (above) is not a per-field guess — the Omni connection this migrates
onto is the same database Power BI itself was already querying, resolved deterministically by matching
against Omni's real registered connections. Trust it exactly like everything else in this list. If that
resolution failed or was ambiguous, that's already a separate `blocker`/`warning` note in the section
below (a connection-mapping problem) — don't try to route around it by guessing a different dialect for
individual fields.

What's genuinely still your job, from the notes section:

- **Calculated columns** (row-context DAX) and **calculated tables** (DAX table expressions) have no
  deterministic SQL equivalent — that's not a gap in the deterministic pass, it's a real limitation
  (Omni has no row-context formula language). Translate the DAX intent into real `sql:` yourself when
  you're confident; otherwise leave a clear YAML comment with the original DAX rather than omitting
  the field/view.
- **Implicit aggregates** (a report visual summing a plain column with no backing DAX measure) have no
  existing Omni field to reference — either point at an existing measure that already does the same
  aggregation, or create one; don't invent a field reference that doesn't exist in the model.

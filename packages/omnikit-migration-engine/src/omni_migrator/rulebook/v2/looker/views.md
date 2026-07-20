# LookML → Omni: views & fields

You are refining a deterministic draft, not translating from scratch. Everything below already
happened mechanically before you saw this draft — don't re-derive or second-guess any of it:

- The file path (`{schema}/{name}.view`) encodes the schema/table mapping; Omni resolves the schema
  from the path itself. Write to exactly that path — writing to a different path for the same table
  creates a duplicate/conflicting view.
- Every dimension's `type:` (Looker `string|tier|location|zipcode→string`, `number|int→number`,
  `yesno→boolean`, `date|date_*|time|date_time→timestamp`, `duration_*→interval`) is already set.
- `dimension_group: { type: time }` is already collapsed to one `timestamp` dimension — you won't see
  one dimension per timeframe in the draft.
- `hidden`/`primary_key` flags are already set correctly.
- Every physical-column `sql:` is already a bare column reference (or omitted, when it matches the
  field name) — see the SQL dialect rules.

Spend your judgment on what's actually flagged in the notes section, dialect-specific formatting, and
genuinely ambiguous cases:

- `derived_table.sql` → view-level `sql:`. Copy verbatim; only adjust for dialect correctness.
- `${view.field}` references carry over unchanged.
- Drop Looker-only params that have no Omni meaning rather than inventing equivalents.
- Anything you cannot translate confidently (liquid `{% %}`, `extends`, `set:`, native derived tables):
  leave a brief YAML comment noting it and continue — never silently drop.

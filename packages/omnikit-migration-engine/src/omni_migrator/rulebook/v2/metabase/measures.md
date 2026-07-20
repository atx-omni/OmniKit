# Metabase → Omni: measures

Already translated deterministically, trust it:

- Legacy `/api/metric` definitions and `type=metric` cards whose aggregation was a plain
  `count`/`sum`/`avg`/`min`/`max`/`median`/`distinct` over a column on the metric's own table →
  `aggregate_type` + `sql` (bare column name, no `${TABLE}` token — Omni doesn't have one).
- `count-where`/`sum-where` whose condition was a simple equals/not-equals (or an AND of them
  across distinct fields) → the measure's `filters:` block. The `is`/`is_not` shape there is the
  *only* Omni measure-filter wire format the deterministic pass has actually confirmed against real
  Omni YAML — don't assume it also handles ranges/OR/other operators; if it had, the measure would
  already carry `filters:` for those cases too.

What was deliberately left untranslated rather than guessed — real limitations, not gaps in the
deterministic pass, each with the raw MBQL aggregation clause as a hint:

- `cum-sum`/`cum-count`/`stddev`/`var`/`share` — no Omni aggregate-type equivalent (mirrors how DAX
  time-intelligence functions have none either).
- Any aggregation over a column reached through a join (Metabase's `source-field`), or over a
  custom `:expression` — cross-table/derived aggregations need real judgment about which Omni join
  path and SQL to use, not a mechanical guess.
- `count-where`/`sum-where` whose condition has an OR, or repeats a condition on the same field —
  translate the intent into real filter SQL yourself; the shape didn't fit the one verified
  `filters:` wire format, not that it's unsupported by Omni.

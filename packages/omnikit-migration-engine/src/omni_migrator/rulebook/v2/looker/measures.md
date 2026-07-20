# LookML → Omni: measures

The `aggregate_type` and `format` on every measure in the draft are already correct — the Looker
`type:`→`aggregate_type` mapping and `value_format_name:`→Omni format-token mapping both happened
deterministically before you saw this draft. Don't re-derive or second-guess them. Looker measure
types with no Omni measure equivalent (table calcs like `running_total`/`percent_of_total`/`rank`)
were already dropped before reaching you — if one mattered, it's called out in the notes section
below, not present as a field here.

The one thing that's genuinely still your job:

- Filtered measures (`filters:`) → Omni `filters:` on the measure. Translate each condition with the
  appropriate filter operator; if a condition is ambiguous, leave it and flag it.

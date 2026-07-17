# Repository guidance

## Synthetic migration fixtures

- Files under `tests/fixtures/semantic-migrations/` and fixture values in `tests/` are fictional parser and workflow regression data.
- Do not present fixture organizations, dashboards, metrics, formulas, identifiers, narratives, or benchmark scores as customer evidence, product recommendations, or canonical Omni examples.
- Do not reuse fixture content in customer-facing copy, generated migration output, prompts, walkthroughs, or documentation unless a test explicitly requires it.
- Product behavior must be described from production code and documented contracts. Runtime AI requests must be built only from the current user's selected artifacts and choices.
- When an example is needed, prefer neutral roles such as `Example organization`, `Source dashboard`, and `Target model`, unless the user supplies a domain or name.
- Keep fixture manifests, source artifacts, expected outputs, and tests synchronized when changing a benchmark.

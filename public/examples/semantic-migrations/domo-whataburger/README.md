# Whataburger-style Domo round-trip example

This is a simulated Domo export reconstructed from the Omni Whataburger demo. It is not customer data, an export from Whataburger, or an export from a production Domo instance.

## Use it

1. Open **BI Migration Studio**.
2. Choose **Manual files** and **Domo**.
3. Select **Load Whataburger Domo example**.
4. Review the four parsed files and the round-trip benchmark.
5. Confirm the inventory, choose a target Omni model, and continue through the normal reviewed migration flow.

The same path can be tested manually by uploading these four files together, in any order:

- `whataburger-dataset-schemas.json`
- `whataburger-beast-modes.json`
- `whataburger-sql-dataflows.json`
- `whataburger-cards.json`

## What it covers

- 6 Domo dataset schemas
- 12 Beast Mode calculations
- 6 SQL DataFlows that represent the Whataburger query-view layer
- 5 SQL join relationships
- 6 Domo Cards that represent the dashboard tabs and visual intent

`manifest.json` is an independent Omni-oriented expectation used by the round-trip evaluator. It is not sent to the Domo parser.

The `expected-omni/` directory is a review-only baseline for the AI-generated result. It contains six query-view files, the relationship graph, `WhataTopic.topic`, and the `WhataDashboard` build specification. It is never uploaded as Domo source evidence and is not deployed automatically.

## Accuracy boundary

The benchmark measures deterministic source-evidence recovery: schemas, calculations, SQL transforms, relationships, Cards, and referenced fields. A score above 90% means OmniKit recovered enough structured evidence to proceed to reviewed AI translation.

It does not prove that generated Omni YAML is correct. Final acceptance still requires:

- generated YAML linting and model validation,
- dev-branch diff review,
- query and metric result reconciliation,
- permission review,
- dashboard visual and interaction review.

The fixture shapes follow Domo's documented dataset schema, Card, Beast Mode, and SQL DataFlow concepts:

- <https://www.domo.com/docs/api-reference/datasets-api/get-dataset-schema>
- <https://www.domo.com/docs/api-reference/datasets-api/get-cards-for-dataset>
- <https://www.domo.com/docs/portal/bff3ab39f7a6b-beast-modes>
- <https://www.domo.com/docs/s/article/360042922994>

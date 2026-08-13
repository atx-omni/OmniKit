# Professional Looker to Omni Migrations

## Release truth

The Looker path is a **Preview** capability. Its first-party deterministic engine
runs in **shadow** until measured parity, live acceptance, named approval, and a
current rollback drill permit primary use. Shadow output is comparison evidence;
the normalized OmniKit parser remains authoritative.

Do not describe a successful synthetic fixture, parser score, or branch validation
as customer-result parity. Permissions and schedules are currently unsupported and
must be reconciled outside the automated semantic and dashboard path.

## Acquisition paths

### Manual files

Upload one coherent LookML project review unit:

- one or more `.model.lkml` files
- every included `.view.lkml` file needed by the selected Explores
- version-controlled `.dashboard.lookml` files for selected dashboards
- `.look.json` or `.looks.json` companion exports for dashboard tiles that reference saved Looks

Review and confirm the normalized inventory before planning. Missing includes,
truncated exports, or unrelated project fragments should be corrected at the
source rather than silently inferred.

### Saved API

Use a vault-backed Looker API 4.0 client credential with only the permissions
needed to read compiled Explores, connections, dashboards, Looks, queries,
dashboard elements, and dashboard filters. Select compiled Explore and dashboard
roots explicitly. OmniKit exchanges the client ID and secret server-side, applies
bounded read-only calls, and does not persist either value in browser state or
migration reports.

Saved API returns `compiled_definition` evidence. The documented project-file API
surface is metadata and is not treated as a raw LookML-content contract. Git or
Manual Files must therefore provide the selected `.lkml` files, includes,
refinements, Liquid, PDT source, manifests, and tests. Both paths normalize into
the same canonical IR V2 shape, but API-only evidence remains partial until this
manual dependency closure is reconciled.

Manual files and Saved API acquisition feed the same canonical IR V2 contract;
their authority differs, so compiled API evidence never impersonates raw LookML.

## Support matrix

| Source behavior | Automated outcome | Required operator action |
| --- | --- | --- |
| Views, dimensions, dimension groups, primary keys | Deterministic candidate | Confirm warehouse mapping and generated Omni field types. |
| Standard aggregate measures | Deterministic candidate | Reconcile representative results. |
| Same-view filtered measures | Deterministic candidate | Validate filter semantics on the target branch. |
| Compound number measures | Deterministic candidate | Validate SQL and aggregation grain. |
| Explores and conventional joins with explicit supported types and keys | Deterministic candidate | Confirm join direction, cardinality, and fanout behavior. Unknown join types, unknown cardinality, and unresolved foreign-key targets block generation. |
| Parameters | Decision required | Review the generated Omni filter and allowed values. |
| Cross-view filtered measures | Decision required | Map, rewrite, or redesign with explicit evidence. |
| Always filters and access filters | Decision required | Recreate governed intent and reconcile user attributes. |
| Native derived tables and SQL PDT persistence behavior | Manual | Design the target query view or upstream transformation, including rebuild and materialization ownership. |
| Extensions, refinements, Liquid, and user attributes | Decision required or manual | Flatten, map identity inputs, or redesign; never silently omit. |
| Access grants and required access grants | Manual | Map grant names, attributes, values, placement, and assignments to reviewed Omni controls. |
| Field data actions | Unsupported | Assign an explicit external workflow redesign; OmniKit does not generate side effects. |
| Dashboard fields, sorts, limits, filters, and listeners | Deterministic candidate | Confirm every tile and listener outcome. |
| Hidden computation fields | Dependency only | Retain for validation but do not expose accidentally. |
| Dynamic group-bys and same-view filtered dynamic measures | Deterministic candidate | Validate the resulting target query. |
| Table calculations and expression fields | Decision required | Rewrite, redesign, or waive with an owner. |
| Pivots | Decision required | Confirm supported target behavior and result shape. |
| Merged results and arbitrary custom visuals | Manual or redesign | Assign a deliberate dashboard outcome. |
| Permissions and schedules | Unsupported | Reconcile independently and record the exception. |

## Governed workflow

1. Acquire compiled source evidence with Saved API and/or authoritative raw LookML
   with Git or Manual Files. Inventory results are discovery only.
2. Confirm inventory completeness and source capability boundaries.
3. Select the destination Omni model and map each warehouse connection.
4. Analyze only the selected dashboard dependency closure.
5. Resolve every typed semantic and dashboard decision. Unsupported behavior must
   be mapped, rewritten, redesigned, deferred, or waived by an owner.
6. Compile approved files and dashboard plans into one fingerprinted package.
7. Write only to a development branch. Never grant an LLM source credentials,
   Omni write authority, or merge authority.
8. Run model validation, Content Validator, representative target query validation,
   sampled data comparison, dashboard-plan validation, and visual review where used.
9. Confirm branch readiness in Omni before constructing dashboards.
10. Build each dashboard independently and export the sanitized reconciliation report.

## Query validation

For every generated or mapped query tile, OmniKit builds a bounded target query from
the visible fields plus hidden and calculation dependencies. It preserves topic,
sort, pivot, and limit intent. Each probe is planned first and then executed with a
small result limit. Source-specific Looker filter expressions remain structural
evidence unless they have been explicitly translated.

A migration cannot claim validation success while a required target query is
missing, stale, or failing. See Omni's documented [Run Query API](https://docs.omni.co/api/queries/run-query),
[model validation](https://docs.omni.co/api/models/validate-model), and
[Content Validator](https://docs.omni.co/api/content-validator/validate-content).

## Sampled data comparison

Use bounded, non-sensitive source and target samples for representative queries.
The comparison is local and stores only status, counts, a preparation fingerprint,
and a summary. Raw rows and generated SQL are not written to reconciliation history.

The local import format is:

```json
{
  "comparisons": [
    {
      "planId": "dashboard-plan-id",
      "tileId": "tile-id",
      "sourceRows": [{ "dimension": "Example", "measure": 100 }],
      "targetRows": [{ "dimension": "Example", "measure": 100 }],
      "numericTolerance": 0.001
    }
  ]
}
```

Limit the file to 200 comparisons and 500 rows per side. Do not use production
PII, secrets, bearer tokens, or unrestricted query exports.

## Reconciliation

The final JSON or Markdown report must account for:

- every selected dashboard and tile outcome
- every semantic mapping, rewrite, creation, deferral, and waiver
- filter-listener inclusion and exclusion outcomes
- target branch and package fingerprints
- target query evidence and sampled comparison summaries
- unsupported permissions and schedules
- dashboard build and retry outcomes
- exception owner, reason, and final disposition

The report deliberately excludes source files, prompts, AI responses, generated
SQL, raw query rows, credentials, and image bytes.

## Rollback

Before promotion, run a source-specific rollback drill. If the deterministic path
regresses, stop the migration and execute:

```bash
npm run rollback:migration-engine -- --source looker --by "<owner>" --reason "<reason>"
```

Set Looker to `shadow` to retain diagnostic comparison or `off` to use only the
native normalized fallback. Do not delete the fallback during promotion.

## Promotion requirements

Primary eligibility requires at least 20 measured shadow observations and all of:

- semantic parity at or above 95 percent
- dashboard parity at or above 90 percent
- stable identity coverage at or above 95 percent
- overall parity at or above 93 percent
- current conformance and live acceptance evidence
- explicit disposition of every partial or unsupported capability
- a named approver and current rollback drill

Even an approved primary path remains Preview until the source registry is changed
through the release process. The product must not infer GA from a passing migration.

## References

- [Omni professional Looker migration guidance](https://docs.omni.co/guides/migrations/looker-to-omni-skill)
- [Omni AI Jobs API](https://docs.omni.co/api/ai/create-ai-job)
- [Omni create or update YAML files](https://docs.omni.co/api/models/create-or-update-yaml-files)
- [Omni merge model branch](https://docs.omni.co/api/model-branches/merge-a-branch)

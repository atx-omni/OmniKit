# Domo to Omni Migration

## Release status

The Domo migration path is **Preview**. It is intended for controlled,
single-operator migrations with branch review and explicit exception ownership.
Manual Files and Saved API acquisition normalize into the same Domo v2 evidence
contract; neither path can bypass dependency closure or human approval.

## Acquisition paths

### Saved API

- OAuth client credentials are the preferred Platform API setup. OmniKit exchanges
  them on the local server and does not return the client secret or short-lived
  access token to the browser.
- A short-lived OAuth access token remains supported for temporary or legacy use.
- An optional Domo Product API developer token enables Deep inventory such as
  Product Search and Beast Mode detail. It remains encrypted in the native vault
  and server-side only.
- Basic inventory remains usable without the Product API token. The coverage card
  identifies missing Deep evidence and requests an export instead of guessing.

### Manual Files

Upload related evidence together as JSON, SQL, text, or one bounded ZIP. The
three-step review identifies each file's contribution, presents conflicts and
handoffs, and requires explicit confirmation before the normalized inventory can
advance. Raw uploads remain transient and can be released from page memory after
normalization.

## Capability matrix

| Domo evidence | OmniKit treatment | Readiness behavior |
| --- | --- | --- |
| Pages and Page/Card membership | Preferred dashboard scope and deterministic Card closure | Missing Page membership or Card detail blocks planning |
| Card Analyzer queries | One reviewed Omni tile specification per exact Card evidence ID | DataSet, fields, Beast Modes, filters, sorts, limits, date grain, summary number, drill layers, and visual properties are checked separately |
| DataSet schemas | Database-backed Omni view candidates | Missing schema blocks planning; a Domo DataSet is not assumed to be a physical target table |
| Row-level Beast Modes | Omni dimension candidates | Formula, return type, DataSet/Card scope, and referenced columns must be present |
| Aggregate or analytic Beast Modes | Omni measure candidates | Prefer an equivalent aggregate type; otherwise require reviewed SQL and grouped-result validation |
| FIXED Beast Modes | Omni level-of-detail dimension candidates | BY/ADD/REMOVE grouping and ALLOW/DENY/NONE filter behavior require explicit equivalence review |
| Variables and dependent Beast Modes | Dashboard control plus reviewed model expression | Type, default, allowed values, dependent calculations, and Card/Page scope must be complete |
| SQL DataFlows | Query-view or warehouse/dbt candidates | SQL dialect, output grain, update mode, recursion, append behavior, and scheduling determine the target |
| Non-SQL Magic ETL graphs | Data-engineering handoff | Preserve the complete tile graph, formulas, inputs, outputs, and update behavior; no automatic graph parity is claimed |
| Recovered joins | Relationship or query-view join candidates | An ON predicate does not prove cardinality; keys, fanout, null behavior, and result grain require approval |
| Drill paths | `drill_fields` or `drill_queries` candidates | Ordered layers, fields, filters, sorts, limits, and any DataSet change must be proven |
| Quick filters, Filter Views, and Card interactions | Dashboard filter, control, or cross-filter candidates | Preserve target Cards, defaults, persistence, and interaction behavior; personal Filter Views do not become shared defaults automatically |
| PDP row policies | User attributes and topic `access_filters` | Security-owner review and identity-class result tests are required |
| PDP column policies and masking | Access grants or conditional field masking | Never translated as row filters; masking method and precedence require field-level tests |
| Ownership and usage | Scope, wave, and reconciliation evidence | Used for prioritization; not deployed as semantic code |
| Schedules and alerts | Operational requirement | Requires an owner, target outcome, or approved exception |
| Workbench and connector configuration | Ingestion handoff | Source configuration and credentials are never copied |
| Workflows, Forms, and Code Engine | Automation/application redesign handoff | Triggers, decisions, side effects, outputs, owner, and SLA remain separately accountable |
| Story, App Studio, custom apps, and embeds | Application redesign handoff | Reusable Cards may migrate; navigation, actions, persistent state, forms, and mobile behavior remain open until resolved or deferred |

## How Domo development is evaluated

Domo content is not one flat dashboard export. OmniKit treats it as a development
and execution graph:

1. **Data acquisition** produces DataSets through connectors, Workbench, SQL
   DataFlows, Magic ETL, or other upstream processes.
2. **Semantic calculations** add row-level, aggregate, analytic, or FIXED Beast
   Modes. DataSet-scoped and Card-scoped calculations remain distinct.
3. **Variables** provide typed, interactive values that are consumed by Beast
   Modes. A Variable is not migrated by copying its current value.
4. **Analyzer** defines each Card's DataSet, fields, calculations, filters, sorts,
   row limit, date grain, summary number, drill behavior, and chart properties.
5. **Pages and App Studio** assemble Cards and add shared filters, navigation,
   actions, persistent state, forms, and mobile behavior.
6. **Governance and operations** add PDP, access, ownership, schedules, alerts,
   Workflows, Forms, and Code Engine behavior.

AI planning receives this normalized dependency graph plus explicit translation
rules. It may propose a typed mapping or rewrite, but it must not invent missing
Analyzer bindings, relationship cardinality, PDP behavior, recipients, or
application logic. Deterministic compilation uses only decisions approved by the
operator.

### Beast Mode decision rules

- A non-aggregated expression such as a `CASE` classification is a dimension,
  not a measure.
- Aggregate and analytic expressions are measures.
- `FIXED` expressions are reviewed as level-of-detail dimensions because their
  grouping and filter-cancellation behavior must be preserved.
- Exact repeated formulas can share one target object. Same-name formulas with
  different logic, and collisions between a physical field and a row-level Beast
  Mode, are preserved additively and block until resolved.
- Function-template and Variable dependencies remain attached to the calculation
  so interactive behavior can be rebuilt rather than flattened.

### Card and Page completion criteria

A Card is not ready for construction merely because its title and chart type are
known. The build plan must identify its DataSet, query fields, filters, sorts,
limit, date grain, summary-number logic, drill layers, relevant Variables and
quick filters, interactions, and visual properties when those features exist.
A Page is complete only when its selected Card membership and shared dependency
closure are accounted for. Story and App Studio behavior is separately reviewed
even when every reusable Card is ready.

## Governed workflow

1. Choose Saved API or Manual Files and confirm the Domo source.
2. Review evidence coverage and select Pages or individual Cards.
3. Inspect dependency closure through Cards, datasets, fields, Beast Modes,
   DataFlows, relationships, governance, operations, and handoffs.
4. Resolve each typed proposal. Map existing Omni objects, create reviewed
   additive code, defer with an owner, or exclude explicitly.
5. Generate deterministic files from approved decisions only.
6. Apply all semantic work to one Omni development branch and run model,
   content, query, data, security, operational, and human review gates.
7. Build one dashboard at a time through Omni AI from the reviewed Card plan.
8. Retry one failed dashboard without rerunning completed semantic work.
9. Export reconciliation showing source-to-target outcomes, dashboard links,
   waivers, and accountable residual work.

## Stop conditions

Do not continue when:

- selected Page or Card closure is incomplete
- a selected Card lacks its dataset or schema
- a planned tile does not reference the exact source Card evidence
- required semantic writes are absent from the generated package
- a security or operational outcome lacks an owner or approved disposition
- target branch validation is stale or failing
- a dashboard build or reconciliation result remains blocking

## Preview acceptance

Synthetic and browser tests are necessary but do not promote Domo. Controlled
Preview acceptance requires one finalized Manual Files record and one Saved API
record for the same representative source scope, target environment, release,
and parser contract. Keep completed evidence outside the repository and run:

```bash
npm run verify:domo-acceptance-campaign -- \
  --campaign /path/to/domo-campaign.json \
  --manual-evidence /path/to/domo-manual-final.json \
  --api-evidence /path/to/domo-api-final.json
```

The verifier requires complete Page, Card, and dependency accounting, zero silent
omissions, distinct development branches, semantic/dashboard/identity/governance
parity, checksummed comparison evidence, named approval, and rollback proof from
the last 90 days. Domo remains Preview until this proof exists.

## Primary references

The migration rules are based on Domo's official documentation for
[Beast Modes](https://www.domo.com/docs/s/article/360043429913),
[Variables](https://www.domo.com/docs/s/article/7903767835031),
[FIXED functions](https://www.domo.com/docs/s/article/4408174643607),
[Analyzer](https://www.domo.com/docs/s/article/360043428673),
[drill paths](https://www.domo.com/docs/s/article/360042924094),
[Page filters and Filter Views](https://www.domo.com/docs/s/article/360042923914),
[Magic ETL](https://www.domo.com/docs/s/article/360047787514),
[SQL DataFlows](https://www.domo.com/docs/s/article/360042922994),
[PDP](https://www.domo.com/docs/s/article/360042934614),
[App Studio](https://www.domo.com/docs/s/article/000005295), and
[Workflows](https://www.domo.com/docs/s/article/000005108). Domo's free
[Analyzer and Beast Mode video library](https://www.domo.com/domo-central/help/videos/label/analyzer-and-beast-mode-)
is useful for understanding author workflows but does not replace API/export
evidence.

Target decisions follow Omni's official documentation for
[dimensions](https://docs.omni.co/modeling/dimensions),
[measures](https://docs.omni.co/modeling/measures),
[level of detail](https://docs.omni.co/modeling/dimensions/parameters/level-of-detail),
[query views](https://docs.omni.co/modeling/query-views),
[relationships](https://docs.omni.co/modeling/relationships/index),
[dashboard filters](https://docs.omni.co/visualize-present/dashboards/filters),
[controls](https://docs.omni.co/visualize-present/dashboards/controls),
[access filters](https://docs.omni.co/modeling/topics/parameters/access-filters),
and [access grants](https://docs.omni.co/modeling/models/access-grants).

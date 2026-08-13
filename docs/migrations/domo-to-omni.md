# Domo to Omni Migration

## Release status

The Domo migration path is **Preview**. It is intended for controlled,
single-operator migrations with branch review and explicit exception ownership.
Manual Files and Saved API acquisition normalize into the same Domo v2 evidence
contract; neither path can bypass dependency closure or human approval.

## Acquisition paths

### Saved API

- Saved API supports independent tenant-bound Product API and Platform OAuth client
  credential families. Product API provides Product Search, DataSet definition/access,
  Card membership, and Beast Mode evidence. Optional OAuth supplements authoritative
  Chart Card, documented Card drill-property, Page-detail, and PDP evidence. Both credential families stay encrypted
  in the native vault and server-side; the exchanged access token is ephemeral.
- The Saved API path is restricted to Domo's documented Product and Platform API contracts: Product
  Search (`/api/search/v1/query`), DataSet metadata/schema/access/Card
  membership, and the Beast Mode search/detail endpoints. The saved tenant origin
  and `X-DOMO-Developer-Token` header are fixed server-side; arbitrary Product API
  paths are not accepted from the browser or operator input.
- Page/Card membership (`/api/content/v1/pages/{pageId}/cards`) is documented only
  in Domo's official PDF Export tutorial, not in the formal Product API reference.
  OmniKit labels it guide-grade and uses it for Preview discovery only; it never
  establishes source completeness, Apply-to-Dev eligibility, or release readiness.
- Product Search is a documented discovery API, but its generic Card search objects
  are not a documented substitute for a complete Analyzer/Card definition.
  The Product API also does not prove complete Analyzer drill semantics or DataSet
  PDP policy lists. Token-only planning therefore requires an acknowledgement bound
  to the exact prepared scope. Those three gaps remain explicit Manual Files
  handoffs and still block release readiness until validated; they also block
  Apply-to-Dev. The acknowledgement never marks source acquisition or dependency
  closure complete.
- Failed access, verified-empty inventory, partial collection,
  and a genuine safety bound are reported as different states. A clean bounded
  Product API catalog validates tenant access but remains discovery metadata only.
  Prepare an exact visible Page or Card, or use focused Manual Files when the required
  root is outside that catalog window.

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

1. Choose Saved API or Manual Files and confirm the Domo source. For Saved API,
   configure a Product API developer token, Platform OAuth client credentials,
   or both; record the exact credential combination in acceptance evidence.
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

Developer-token Analyzer-definition/drill/PDP limitations are the narrow exception
for **Preview planning only**: the operator may acknowledge those three exact gaps
for the current prepared scope, but must retain them as manual validation and
handoff requirements.
The acknowledgement cannot waive missing dependencies, other API failures,
truncation, query validation, security validation, or release acceptance.
No generated package may be applied to an Omni development branch until the
Analyzer/Card definition, drill-path, and PDP evidence is supplied through OAuth or
focused Manual Files and validated.

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

The Saved API implementation is bound to Domo's official
[API authentication and coverage guidance](https://www.domo.com/docs/portal/API-Reference/overview),
[Product Search](https://www.domo.com/docs/api-reference/search-product-api/query),
[DataSet metadata](https://www.domo.com/docs/api-reference/datasets-api/get-metadata),
[DataSet schema](https://www.domo.com/docs/api-reference/dataset-schema-api/return-the-schema-for-a-specified-dataset),
[DataSet access](https://www.domo.com/docs/api-reference/datasets-api/dataset-access-list),
[DataSet Card membership](https://www.domo.com/docs/api-reference/datasets-api/get-cards-for-dataset),
[OAuth Card drill properties](https://www.domo.com/docs/portal/0945428d284ab-get-drill-properties),
[Beast Mode search](https://www.domo.com/docs/api-reference/beast-modes/get-all-beast-modes), and
[Beast Mode detail](https://www.domo.com/docs/api-reference/beast-modes/get-beast-mode-by-id).
The Page/Card membership read is separately classified as guide-grade based on
Domo's official [PDF Export tutorial](https://www.domo.com/docs/portal/Apps/Pro-Code-Editor/Tutorials/pdf-export),
not as a formal Product API reference contract.
The broader migration rules are based on Domo's official documentation for
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

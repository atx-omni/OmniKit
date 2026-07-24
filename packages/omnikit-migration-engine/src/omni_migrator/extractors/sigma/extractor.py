"""Sigma extractor: REST API (data models) -> canonical IR. Model-only (dashboards are
`extractors/sigma/dashboard.py`, same Phase-2 split every other source uses).

Sigma is the second *API-only* source after Metabase (§6.5) — no file artifact exists at all, so
`extract()` keys off `ApiInput`, and the actual network acquisition (`SigmaApi.snapshot()`) happens
inside it. The core transform, `_build_bundle`, is a pure function over the resulting plain-dict
snapshot, mirroring `metabase/extractor.py`'s `_build_bundle` split — unit-testable offline with
no server. An `ApiInput` whose `auth` dict carries a pre-fetched `"snapshot"` skips the network
call entirely, same convention as Metabase/Looker.

**Build against "data models," never the deprecated "datasets"** (plan §6.4) — datasets can't be
edited after 2026-06-02 and are gone entirely by 2026-09-15; `GET /v2/datasets/{id}` is already
marked deprecated in Sigma's own API reference.

Mapping (plan §6.4):
- A data model spec's `pages[].elements[]` (`kind: "table"`) -> `ViewIR`, one per element; its
  `source.path` (`[db, schema, table]`) -> `schema_name`/`source_table`, the same confidence tier
  as Looker's `sql_table_name` split or Metabase's `table.schema`.
- `columns[]` -> `FieldIR` dimensions. A column whose `formula` is empty, or a bare passthrough
  ref to its own name, is a plain physical column (bare `sql:`, Omni infers the rest). Any other
  formula is a genuine calculated column — no deterministic Omni equivalent for row-context
  expressions (same posture as Power BI's DAX calculated columns, `powerbi/extractor.py`
  `_add_calculated_columns`): flagged `untranslatable` with the formula as hint, no `FieldIR` added,
  always AI.
- **Metrics** (Sigma's reusable, standardized calcs — analogous to Omni measures, distinct from
  plain `columns[]`) -> a real measure via `deterministic.sigma_translate.translate_formula`,
  same "translate the clean aggregate wrapper, flag the rest" discipline as DAX/MBQL. This is
  where `SumIf`/`CountIf`/`AvgIf` become filtered measures — a genuinely tractable deterministic
  win Sigma's own formula-condition syntax gives us (plan §6.4).
- Relationships (joins) -> `TopicIR`/`JoinIR`. **The exact relationship JSON shape was not given
  in Sigma's public docs excerpt this was built against** (only that it exists) — modeled here as
  a best-effort `{fromElementId, fromColumnId, toElementId, toColumnId, type}` shape. Treat with
  the same skepticism as Tableau's join-clause XML assumption until verified live (plan §6.4).
- Connections -> `ConnectionRef.dialect` via `api.normalize_sigma_connection_type` — Sigma gives a
  real `type` field (not a heuristic sniffed from free text the way Power BI's Power Query M
  detection is), but the full enum of values wasn't found in the docs (only `"bigQuery"` appears
  in an inline example) — extend `api._TYPE_DIALECT` before relying on it beyond Snowflake/BigQuery.

**Simplification, not yet built**: the "workbook has no promoted data model, fall back to its own
`/spec`" case (plan §6.4) needs knowing which workbooks lack a linked data model, and the
documented workbook shape doesn't show that link explicitly — `extract_workbook_spec` below
exists and can be pointed at a specific workbook's `/spec` directly, but nothing auto-detects the
need for it yet. Revisit once a live org shows the real `get_workbook()` response shape.
"""

from __future__ import annotations

import re

from omni_migrator.core.contracts import ApiInput, ExtractCtx, ExtractorInput
from omni_migrator.deterministic.sigma_translate import parse_ref, translate_formula
from omni_migrator.extractors.sigma.api import SigmaApi, normalize_sigma_connection_type
from omni_migrator.ir.schema import (
    ConnectionRef,
    FieldIR,
    JoinIR,
    MigrationBundle,
    ModelIR,
    Provenance,
    TopicIR,
    UntranslatableNote,
    ViewIR,
)


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", (text or "").strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _is_passthrough(formula: str | None, column_name: str) -> bool:
    """A column whose formula is empty, or a bare same-table ref to its own name, is a plain
    physical column — Omni infers the rest when the field name already matches (same rule
    `model_emitter._bare_sql` applies at emit time)."""
    if not formula:
        return True
    ref = parse_ref(formula)
    return ref is not None and ref[0] is None and ref[1].strip().lower() == column_name.strip().lower()


def _build_views(
    data_model: dict, dialects: dict[str, str],
) -> tuple[dict[str, ViewIR], dict[str, str], dict[str, tuple[str, str]]]:
    """-> (views by view-name, view-name by element-id, (view-name, column-name) by column-id)."""
    views: dict[str, ViewIR] = {}
    element_view: dict[str, str] = {}
    column_ref: dict[str, tuple[str, str]] = {}
    for page in data_model.get("spec", {}).get("pages", []):
        for element in page.get("elements", []):
            if element.get("kind") != "table":
                continue
            source = element.get("source") or {}
            path = source.get("path") or []
            table = path[-1] if path else None
            schema = path[-2] if len(path) >= 2 else None
            name = _snake(element.get("name") or table or element.get("id") or "")
            element_view[element.get("id")] = name
            view = ViewIR(
                name=name, source_table=table, schema_name=schema,
                connection=ConnectionRef(
                    source_connection_name=source.get("connectionId"),
                    dialect=dialects.get(source.get("connectionId"), "other"),
                ),
            )
            for col in element.get("columns", []):
                col_name = _snake(col.get("name") or "")
                column_ref[col.get("id")] = (name, col_name)
                formula = col.get("formula")
                if _is_passthrough(formula, col.get("name") or col_name):
                    view.fields.append(
                        FieldIR(
                            name=col_name, source_name=col.get("name"), kind="dimension",
                            sql=col_name,  # bare column name — Omni has no ${TABLE} token
                            description=col.get("description") or None,
                            hidden=bool(col.get("hidden")),
                        )
                    )
                    continue
                # A genuine calculated column — row-context Sigma formula, no deterministic
                # Omni equivalent (same posture as Power BI DAX calculated columns): flag, don't
                # add a FieldIR, always AI.
                view.untranslatable.append(
                    UntranslatableNote(
                        object=f"calculated column {element.get('name') or table}[{col.get('name')}]",
                        reason="Sigma calculated column (row-context formula); no deterministic Omni equivalent.",
                        severity="warning",
                        hint=formula,
                    )
                )
            views[name] = view
    return views, element_view, column_ref


def _build_relationships(
    data_model: dict, views: dict[str, ViewIR], element_view: dict[str, str], column_ref: dict[str, tuple[str, str]],
) -> dict[str, TopicIR]:
    """Relationships (joins) -> `TopicIR`/`JoinIR`. **Best-effort shape** — Sigma's public docs
    excerpt this was built against mentions relationships exist but does not show their JSON
    shape; assumed here to be a top-level `relationships[]` list of
    `{fromElementId, fromColumnId, toElementId, toColumnId, type}`. Not verified live — see the
    module docstring."""
    topics: dict[str, TopicIR] = {}
    for rel in data_model.get("spec", {}).get("relationships", []):
        from_view = element_view.get(rel.get("fromElementId"))
        to_view = element_view.get(rel.get("toElementId"))
        from_col = column_ref.get(rel.get("fromColumnId"))
        to_col = column_ref.get(rel.get("toColumnId"))
        if not (from_view and to_view and from_col and to_col):
            continue
        rel_type = rel.get("type") or "many-to-one"
        relationship_type = "one_to_one" if rel_type in ("one-to-one", "one_to_one") else "many_to_one"
        topic = topics.setdefault(from_view, TopicIR(name=from_view, base_view=from_view))
        topic.joins.append(
            JoinIR(
                join_from_view=from_view, join_to_view=to_view, relationship_type=relationship_type,
                on_sql=f"${{{from_view}.{from_col[1]}}} = ${{{to_view}.{to_col[1]}}}",
            )
        )
        views[from_view].untranslatable.append(
            UntranslatableNote(
                object=f"join {from_view}.{from_col[1]} -> {to_view}.{to_col[1]}",
                reason="Relationship shape inferred from Sigma's data-model spec, not verified "
                "against a live instance — confirm the direction/cardinality before trusting it.",
                severity="info",
            )
        )
    return topics


def _build_metrics(data_model: dict, views: dict[str, ViewIR], element_view: dict[str, str]) -> None:
    """Metrics (Sigma's reusable, standardized calcs — analogous to Omni measures, distinct from
    plain `columns[]`) -> a real measure, same "translate the clean wrapper, flag the rest"
    discipline as DAX/MBQL. **Best-effort shape** for where a metric lives — assumed to be a
    top-level `metrics[]` list of `{id, name, elementId, formula, description}`; not verified live."""
    for metric in data_model.get("spec", {}).get("metrics", []):
        view_name = element_view.get(metric.get("elementId"))
        if view_name is None:
            continue
        view = views[view_name]
        sql, aggregate, filters, reason = translate_formula(metric.get("formula") or "", home_table=view_name)
        if reason:
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"metric {metric.get('name')}", severity="warning",
                    reason=reason, hint=metric.get("formula"),
                )
            )
            continue
        field = FieldIR(
            name=_snake(metric.get("name") or f"metric_{metric.get('id')}"),
            source_name=metric.get("name"), kind="measure", data_type="number",
            sql=sql, aggregate=aggregate, description=metric.get("description") or None,
        )
        if filters:
            field.filters = filters
        view.fields.append(field)


def _build_bundle(snapshot: dict, ctx: ExtractCtx | None = None) -> MigrationBundle:
    """Pure transform: a plain-dict Sigma `snapshot` (see `SigmaApi.snapshot()`) -> `MigrationBundle`."""
    ctx = ctx or ExtractCtx()
    requested = ctx.scope.get("workbook_ids") or ctx.scope.get("dashboard_ids") or ctx.scope.get("selected_dashboard_ids") or []
    if isinstance(requested, str):
        selected_ids = {requested}
    elif isinstance(requested, list):
        selected_ids = {str(item) for item in requested if str(item).strip()}
    else:
        selected_ids = set()
    dialects = {
        c["connectionId"]: normalize_sigma_connection_type(c.get("type"))
        for c in snapshot.get("connections", [])
    }
    all_views: dict[str, ViewIR] = {}
    all_topics: dict[str, TopicIR] = {}
    all_column_refs: dict[str, tuple[str, str]] = {}
    for dm in snapshot.get("dataModels", []):
        views, element_view, column_ref = _build_views(dm, dialects)
        _build_metrics(dm, views, element_view)
        topics = _build_relationships(dm, views, element_view, column_ref)
        all_views.update(views)
        all_topics.update(topics)
        all_column_refs.update(column_ref)

    model = ModelIR(views=list(all_views.values()), topics=list(all_topics.values()))
    from omni_migrator.extractors.sigma.dashboard import translate_sigma_page

    dashboards = []
    for workbook in snapshot.get("workbooks", []):
        workbook_id = str(workbook.get("workbookId") or workbook.get("id") or "").strip() or None
        workbook_selected = not selected_ids or (workbook_id is not None and workbook_id in selected_ids)
        for page in workbook.get("pages", []):
            page_id = str(page.get("pageId") or page.get("id") or "").strip() or None
            if not workbook_selected and (page_id is None or page_id not in selected_ids):
                continue
            dashboards.append(translate_sigma_page(
                page,
                column_ref=all_column_refs,
                source_url=workbook.get("url") or workbook.get("name"),
                workbook_id=workbook_id,
            ))
    return MigrationBundle(source="sigma", provenance=Provenance(), model=model, dashboards=dashboards)


class SigmaExtractor:
    source = "sigma"

    def detect(self, inp: ExtractorInput) -> bool:
        return isinstance(inp, ApiInput)

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx | None = None) -> MigrationBundle:
        ctx = ctx or ExtractCtx()
        if not isinstance(inp, ApiInput):
            raise TypeError("SigmaExtractor supports ApiInput (Sigma is API-only).")
        snapshot = inp.auth.get("snapshot")
        if snapshot is None:
            api = SigmaApi(
                base_url=inp.base_url,
                client_id=inp.auth.get("client_id"), client_secret=inp.auth.get("client_secret"),
            )
            snapshot = api.snapshot()
        bundle = _build_bundle(snapshot, ctx)
        bundle.provenance.source_artifact = inp.base_url
        return bundle

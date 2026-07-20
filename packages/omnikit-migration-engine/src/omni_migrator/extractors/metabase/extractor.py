"""Metabase extractor: REST API (databases/tables/fields/segments/metrics) -> canonical IR.

Model-only (dashboards are `extractors/metabase/dashboard.py`, Phase 2 like every other source).
Metabase is the first *API-only* source — no file artifact exists at all, so `extract()` keys off
`ApiInput`, and the actual network acquisition (`MetabaseApi.snapshot()`) happens inside it. The
core transform, `_build_bundle`, is still a pure function over the resulting plain-dict snapshot,
so it's unit-testable offline with no server — mirrors `powerbi/extractor.py`'s `_build_bundle`
split, minus the DataFrame duck-typing (Metabase's API is already plain JSON). An `ApiInput` whose
`auth` dict carries a pre-fetched `"snapshot"` skips the network call entirely — this is also how
the CLI's `--from-json` offline mode and these tests work (plan risk #5).

Mapping (plan §6.5):
- `database.engine` -> `ConnectionRef.dialect` (`api.normalize_metabase_engine`).
- `table` + `query_metadata` fields -> `ViewIR`/`FieldIR` (dimensions); `semantic_type: type/PK` ->
  `primary_key`. Deterministic, no MBQL involved — same confidence tier as Power BI's `.schema`.
- `semantic_type: type/FK` + `fk_target_field_id` -> `TopicIR`/`JoinIR`. Cardinality is *inferred*
  (always `many_to_one` from the FK side) since Metabase's field metadata carries no cardinality of
  its own, unlike Power BI's `Cardinality` column (plan risk #6) — flagged with an info note, not
  silently assumed.
- `segment.definition.filter` -> a yesno dimension via `mbql_translate.translate_filter_clause`
  (raw boolean SQL); doesn't compile -> `untranslatable` with the raw MBQL as hint.
- Legacy `/api/metric` and `type=metric` cards' aggregation clause -> a measure via
  `mbql_translate.translate_aggregation`; doesn't compile -> `untranslatable`.
- `type=model` cards: native-SQL models become a derived-table `ViewIR` (raw SQL verbatim,
  unresolved `{{tag}}` variables flagged). MBQL-based models are **not** compiled into a view in v1
  — that needs full query->SQL generation (joins/filters/aggregation as one SELECT), out of scope
  for the aggregation/filter/expression-level translator built here — flagged `untranslatable` at
  the model level instead of guessed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from omni_migrator.core.contracts import ApiInput, ExtractCtx, ExtractorInput, FileInput
from omni_migrator.deterministic.mbql_translate import (
    FieldMeta,
    normalize_query_stage,
    translate_aggregation,
    translate_filter_clause,
)
from omni_migrator.extractors.metabase.api import MetabaseApi, normalize_metabase_engine
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

_BASE_TYPE_MAP = {
    "type/BigInteger": "number", "type/Integer": "number", "type/Float": "number",
    "type/Decimal": "number", "type/Text": "string", "type/VARCHAR": "string", "type/UUID": "string",
    "type/Boolean": "boolean", "type/Date": "date", "type/DateTime": "timestamp",
    "type/DateTimeWithTZ": "timestamp", "type/DateTimeWithLocalTZ": "timestamp",
}
_TEMPLATE_TAG = re.compile(r"\{\{\s*[\w.]+\s*\}\}")


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", (text or "").strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _omni_data_type(base_type: str | None) -> str:
    return _BASE_TYPE_MAP.get(base_type or "", "string")


def _build_views(
    tables: list[dict], dialects: dict[int, str]
) -> tuple[dict[str, ViewIR], dict[int, FieldMeta], dict[int, str]]:
    """-> (views by view-name, field_index by Metabase field id, view-name by table id)."""
    views: dict[str, ViewIR] = {}
    field_index: dict[int, FieldMeta] = {}
    table_view: dict[int, str] = {}
    for table in tables:
        name = _snake(table.get("name") or "")
        table_view[table["id"]] = name
        view = ViewIR(
            name=name, source_table=table.get("name"), schema_name=table.get("schema"),
            connection=ConnectionRef(
                source_connection_name=str(table.get("db_id")),
                dialect=dialects.get(table.get("db_id"), "other"),
            ),
        )
        for f in table.get("fields", []):
            field_name = _snake(f.get("name") or "")
            field_index[f["id"]] = FieldMeta(view=name, name=field_name, table_id=table["id"])
            view.fields.append(
                FieldIR(
                    name=field_name, source_name=f.get("name"), kind="dimension",
                    data_type=_omni_data_type(f.get("base_type")),
                    sql=field_name,  # bare column name — Omni has no ${TABLE} token
                    primary_key=f.get("semantic_type") == "type/PK",
                    description=f.get("description") or None,
                )
            )
        views[name] = view
    return views, field_index, table_view


def _build_joins(
    tables: list[dict], views: dict[str, ViewIR],
    field_index: dict[int, FieldMeta], table_view: dict[int, str],
) -> dict[str, TopicIR]:
    topics: dict[str, TopicIR] = {}
    for table in tables:
        from_view = table_view[table["id"]]
        for f in table.get("fields", []):
            if f.get("semantic_type") != "type/FK" or not f.get("fk_target_field_id"):
                continue
            target_meta = field_index.get(f["fk_target_field_id"])
            if target_meta is None:
                continue
            from_field, to_view, to_field = _snake(f.get("name") or ""), target_meta.view, target_meta.name
            topic = topics.setdefault(from_view, TopicIR(name=from_view, base_view=from_view))
            topic.joins.append(
                JoinIR(
                    join_from_view=from_view, join_to_view=to_view, relationship_type="many_to_one",
                    on_sql=f"${{{from_view}.{from_field}}} = ${{{to_view}.{to_field}}}",
                )
            )
            views[from_view].untranslatable.append(
                UntranslatableNote(
                    object=f"join {from_view}.{from_field} -> {to_view}.{to_field}",
                    reason="Relationship cardinality is inferred as many_to_one from the FK side — "
                    "Metabase's field metadata carries no explicit cardinality (unlike Power BI's "
                    "Cardinality column); verify before trusting a 1:1 relationship.",
                    severity="info",
                )
            )
    return topics


_ALIAS_TABLE = re.compile(r"(?:from|join)\s+([a-zA-Z_]\w*)(?:\s+(?:as\s+)?([a-zA-Z_]\w*))?", re.IGNORECASE)
_ON_EQUALITY = re.compile(r"\bon\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)", re.IGNORECASE)
_SQL_RESERVED = {
    "on", "where", "group", "order", "limit", "having", "join", "inner", "left",
    "right", "full", "outer", "using", "select",
}


def _sql_join_edges(sql: str, table_names: dict[str, str]) -> list[tuple[str, str, str, str]]:
    """Best-effort `... FROM a JOIN b ON a.x = b.y` scan (not a real SQL parser) -> a list of
    `(view_a, col_a, view_b, col_b)` edges. `table_names` maps lowercased physical table name
    -> view name; aliases are resolved from the same `FROM`/`JOIN` tokens."""
    alias_to_view: dict[str, str] = {}
    for m in _ALIAS_TABLE.finditer(sql or ""):
        table_tok, alias_tok = m.group(1).lower(), (m.group(2) or "").lower()
        view = table_names.get(table_tok)
        if not view:
            continue
        alias_to_view[table_tok] = view
        if alias_tok and alias_tok not in _SQL_RESERVED:
            alias_to_view[alias_tok] = view
    edges = []
    for m in _ON_EQUALITY.finditer(sql or ""):
        l_alias, l_col, r_alias, r_col = (g.lower() for g in m.groups())
        l_view, r_view = alias_to_view.get(l_alias), alias_to_view.get(r_alias)
        if l_view and r_view and l_view != r_view:
            edges.append((l_view, l_col, r_view, r_col))
    return edges


def _build_sql_inferred_joins(
    cards: list[dict], views: dict[str, ViewIR], tables: list[dict], topics: dict[str, TopicIR],
) -> None:
    """Infer relationships from dashboard cards' native-SQL `JOIN ... ON a.x = b.y` clauses when
    Metabase's own FK metadata (`_build_joins`) found none — real-world Postgres schemas are often
    synced without DB-level FK constraints, so `semantic_type: type/FK` may never get set even
    though the relationship is obviously in active use on dashboards. Same posture as `_build_joins`:
    cardinality is a guess (`many_to_one`), flagged as an `info` note rather than asserted as fact.
    Skips any pair of views that already has a join between them (from FK metadata or an earlier
    card) — first one seen wins."""
    table_names = {(t.get("name") or "").lower(): _snake(t.get("name") or "") for t in tables}
    already_joined: set[frozenset[str]] = {
        frozenset((j.join_from_view, j.join_to_view)) for topic in topics.values() for j in topic.joins
    }
    for card in cards:
        if card.get("type") not in (None, "question"):
            continue
        is_native, query = normalize_query_stage(card.get("dataset_query") or {})
        if not is_native:
            continue
        for view_a, col_a, view_b, col_b in _sql_join_edges(query.get("query", ""), table_names):
            pair = frozenset((view_a, view_b))
            if pair in already_joined:
                continue
            already_joined.add(pair)
            # Heuristic: the side joined on its own `id` is the "one" side (join target); the
            # other is the "many"/FK side. Falls back to (a=from, b=to) if neither/both are `id`.
            from_view, from_field, to_view, to_field = view_a, col_a, view_b, col_b
            if col_a == "id" and col_b != "id":
                from_view, from_field, to_view, to_field = view_b, col_b, view_a, col_a
            topic = topics.setdefault(from_view, TopicIR(name=from_view, base_view=from_view))
            topic.joins.append(
                JoinIR(
                    join_from_view=from_view, join_to_view=to_view, relationship_type="many_to_one",
                    on_sql=f"${{{from_view}.{from_field}}} = ${{{to_view}.{to_field}}}",
                )
            )
            views[from_view].untranslatable.append(
                UntranslatableNote(
                    object=f"join {from_view}.{from_field} -> {to_view}.{to_field}",
                    reason=f"Relationship inferred from dashboard card {card.get('name')!r}'s SQL "
                    "join, not Metabase FK metadata (none is defined for this table) — verify the "
                    "direction/cardinality before trusting it.",
                    severity="info",
                )
            )


def _build_segments(
    segments: list[dict], views: dict[str, ViewIR],
    field_index: dict[int, FieldMeta], table_view: dict[int, str],
) -> None:
    for seg in segments:
        view_name = table_view.get(seg.get("table_id"))
        if view_name is None:
            continue
        view = views[view_name]
        filter_clause = (seg.get("definition") or {}).get("filter")
        if filter_clause is None:
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"segment {seg.get('name')}", severity="warning",
                    reason="Segment has no filter definition.",
                )
            )
            continue
        sql, reason = translate_filter_clause(filter_clause, field_index, seg["table_id"])
        if reason:
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"segment {seg.get('name')}", severity="warning",
                    reason=reason, hint=str(filter_clause),
                )
            )
            continue
        view.fields.append(
            FieldIR(
                name=_snake(seg.get("name") or f"segment_{seg.get('id')}"),
                source_name=seg.get("name"), kind="dimension", data_type="boolean", sql=sql,
                description=seg.get("description") or None,
            )
        )


def _metric_shape(metric: dict) -> tuple[int | None, list | None]:
    """Normalize legacy `/api/metric` and `type=metric` card shapes -> (table_id, agg clause).

    `type=metric` cards' `dataset_query` goes through `normalize_query_stage` (verified live: it's
    the same pMBQL `stages` shape as any other card, §6.5). The legacy `/api/metric` endpoint's
    `definition` is a distinct, older API surface we have not verified live — left as-is.
    """
    if "dataset_query" in metric:
        _, q = normalize_query_stage(metric.get("dataset_query") or {})
        agg = q.get("aggregation") or []
        return q.get("source-table"), (agg[0] if agg else None)
    definition = metric.get("definition") or {}
    agg = definition.get("aggregation") or []
    return metric.get("table_id"), (agg[0] if agg else None)


def build_metric_field_names(metrics: list[dict], field_index: dict[int, FieldMeta]) -> dict[int, str]:
    """Metric id -> the field name `_build_metrics` would emit for it — only for metrics that
    actually compile deterministically (mirrors the same `translate_aggregation` check). Used by
    the dashboard-migration CLI step to resolve `["metric", id]` aggregation references in card
    queries back to the measure field the model step already created.
    """
    names: dict[int, str] = {}
    for metric in metrics:
        if metric.get("id") is None:
            continue
        table_id, agg_clause = _metric_shape(metric)
        if agg_clause is None:
            continue
        _, _, _, reason = translate_aggregation(agg_clause, field_index, table_id)
        if reason:
            continue
        names[metric["id"]] = _snake(metric.get("name") or f"metric_{metric['id']}")
    return names


def _build_metrics(
    metrics: list[dict], views: dict[str, ViewIR],
    field_index: dict[int, FieldMeta], table_view: dict[int, str],
) -> None:
    for metric in metrics:
        table_id, agg_clause = _metric_shape(metric)
        view_name = table_view.get(table_id)
        if view_name is None or agg_clause is None:
            continue
        view = views[view_name]
        sql, aggregate, filters, reason = translate_aggregation(agg_clause, field_index, table_id)
        if reason:
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"metric {metric.get('name')}", severity="warning",
                    reason=reason, hint=str(agg_clause),
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


def _build_models(
    cards: list[dict], views: dict[str, ViewIR], dialects: dict[int, str]
) -> list[UntranslatableNote]:
    model_notes: list[UntranslatableNote] = []
    for card in cards:
        if card.get("type") != "model":
            continue
        dq = card.get("dataset_query") or {}
        name = _snake(card.get("name") or f"model_{card.get('id')}")
        is_native, query = normalize_query_stage(dq)
        if not is_native:
            model_notes.append(
                UntranslatableNote(
                    object=f"model {card.get('name')}", severity="warning",
                    reason="MBQL-based Model; compiling its full query into a derived-table SQL view "
                    "needs whole-query SQL generation (joins/filters/aggregation as one SELECT), out "
                    "of scope for the aggregation/filter-level translator built here — needs AI translation.",
                    hint=str(query),
                )
            )
            continue
        sql = query.get("query", "")
        view = ViewIR(
            name=name, sql=sql, description=card.get("description") or None,
            connection=ConnectionRef(
                source_connection_name=str(dq.get("database")),
                dialect=dialects.get(dq.get("database"), "other"),
            ),
        )
        if _TEMPLATE_TAG.search(sql or ""):
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"model {card.get('name')}", severity="warning",
                    reason="Native-SQL Model has unresolved {{template-tag}} variables; Omni "
                    "derived-table SQL has no template-variable concept.",
                    hint=sql,
                )
            )
        views[name] = view
    return model_notes


_FROM_JOIN_TABLE = re.compile(r"(?:from|join)\s+([a-zA-Z_][\w]*)\.?([a-zA-Z_][\w]*)?", re.IGNORECASE)


def _tables_referenced_in_sql(sql: str, table_names: dict[str, str]) -> set[str]:
    """Best-effort `FROM`/`JOIN` scan (not a real SQL parser) to identify which known tables a
    native-SQL card touches — enough to decide which view(s) a hint belongs on, not to
    understand the query. `table_names` maps lowercased physical table name -> view name."""
    found: set[str] = set()
    for m in _FROM_JOIN_TABLE.finditer(sql or ""):
        candidate = (m.group(2) or m.group(1) or "").lower()
        if candidate in table_names:
            found.add(table_names[candidate])
    return found


def _build_card_hints(cards: list[dict], views: dict[str, ViewIR], tables: list[dict]) -> None:
    """Surface raw SQL from ordinary dashboard/ad-hoc question cards (not saved Metrics or
    Models, which already compile deterministically elsewhere) onto the view(s) they touch.

    A card like "Revenue by Brand" — `sum(sale_price)` joined against another table, saved as
    a plain question rather than a Metric — is real, actively-used business logic the
    deterministic pass has no way to detect on its own. Before this, that SQL was only ever
    visible to the *dashboard*-migration AI job (as a per-tile hint); the *modeling* AI job
    never saw it, so a measure like `revenue` had no path onto the model even though a chart
    built entirely from it was already live on a dashboard. Native-SQL only for now — MBQL
    cards with a source-table + plain aggregation are already handled by `_build_metrics`-style
    translation when they're saved as Metrics, and a bare `question` card's simple MBQL
    aggregation over one table doesn't need surfacing (nothing new to add over what schema
    introspection already produced)."""
    table_names = {(t.get("name") or "").lower(): _snake(t.get("name") or "") for t in tables}
    for card in cards:
        if card.get("type") not in (None, "question"):
            continue
        is_native, query = normalize_query_stage(card.get("dataset_query") or {})
        if not is_native:
            continue
        sql = query.get("query", "")
        touched = _tables_referenced_in_sql(sql, table_names)
        for view_name in touched:
            view = views.get(view_name)
            if view is None:
                continue
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"dashboard card {card.get('name')!r}",
                    severity="info",
                    reason=(
                        "Ad-hoc native-SQL question (not a saved Metric) referencing this table — "
                        "its aggregation may be reusable business logic (e.g. a revenue/margin "
                        "measure) worth adding to this view as a real measure."
                    ),
                    hint=sql,
                )
            )


def _build_bundle(snapshot: dict, ctx: ExtractCtx | None = None) -> MigrationBundle:
    """Pure transform: a plain-dict Metabase `snapshot` (see `MetabaseApi.snapshot()`) -> `MigrationBundle`."""
    ctx = ctx or ExtractCtx()
    requested = ctx.scope.get("dashboard_ids") or ctx.scope.get("selected_dashboard_ids") or []
    if isinstance(requested, str):
        selected_dashboard_ids = {requested}
    elif isinstance(requested, list):
        selected_dashboard_ids = {str(item) for item in requested if str(item).strip()}
    else:
        selected_dashboard_ids = set()
    dialects = {d["id"]: normalize_metabase_engine(d.get("engine")) for d in snapshot.get("databases", [])}
    tables = snapshot.get("tables", [])
    views, field_index, table_view = _build_views(tables, dialects)
    topics = _build_joins(tables, views, field_index, table_view)
    _build_sql_inferred_joins(snapshot.get("cards", []), views, tables, topics)
    _build_segments(snapshot.get("segments", []), views, field_index, table_view)
    _build_metrics(snapshot.get("metrics", []), views, field_index, table_view)
    model_notes = _build_models(snapshot.get("cards", []), views, dialects)
    _build_card_hints(snapshot.get("cards", []), views, tables)

    model = ModelIR(views=list(views.values()), topics=list(topics.values()), untranslatable=model_notes)
    from omni_migrator.extractors.metabase.dashboard import translate_metabase_dashboard

    cards_by_id = {card["id"]: card for card in snapshot.get("cards", []) if card.get("id") is not None}
    metric_field_names = build_metric_field_names(snapshot.get("metrics", []), field_index)
    dashboards = [
        translate_metabase_dashboard(
            dashboard,
            cards_by_id=cards_by_id,
            field_index=field_index,
            table_view=table_view,
            metric_field_names=metric_field_names,
        )
        for dashboard in snapshot.get("dashboards", [])
        if not selected_dashboard_ids or str(dashboard.get("id")) in selected_dashboard_ids
    ]
    return MigrationBundle(source="metabase", provenance=Provenance(), model=model, dashboards=dashboards)


class MetabaseExtractor:
    source = "metabase"

    def detect(self, inp: ExtractorInput) -> bool:
        return isinstance(inp, ApiInput) or (
            isinstance(inp, FileInput) and any(str(path).lower().endswith(".json") for path in inp.paths)
        )

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx | None = None) -> MigrationBundle:
        ctx = ctx or ExtractCtx()
        if isinstance(inp, FileInput):
            if len(inp.paths) != 1:
                raise ValueError("Metabase manual extraction requires one complete API snapshot JSON file.")
            path = Path(inp.paths[0])
            snapshot = json.loads(path.read_text())
            if not isinstance(snapshot, dict):
                raise ValueError("Metabase snapshot JSON must contain one object.")
            bundle = _build_bundle(snapshot, ctx)
            bundle.provenance.source_artifact = str(path)
            return bundle
        if not isinstance(inp, ApiInput):
            raise TypeError("MetabaseExtractor supports ApiInput or one snapshot JSON FileInput.")
        snapshot = inp.auth.get("snapshot")
        if snapshot is None:
            api = MetabaseApi(
                base_url=inp.base_url,
                username=inp.auth.get("username"), password=inp.auth.get("password"),
                api_key=inp.auth.get("api_key"),
            )
            snapshot = api.snapshot()
        bundle = _build_bundle(snapshot, ctx)
        bundle.provenance.source_artifact = inp.base_url
        return bundle

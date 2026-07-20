"""Metabase `dashboard` + `dashcard` (layout) -> `DashboardIR`.

Structurally closer to `looker/dashboard.py` (one dashboard object with a native
parameters/filters system, unit-based grid) than `powerbi/dashboard.py` (pixel canvas,
one-DashboardIR-per-report-page) — Metabase, like Looker, has a single dashboard object.

Card queries (MBQL `dataset_query`) resolve to `QueryIR` the same way Power BI's `prototypeQuery`
does: only fields/breakouts/aggregations with an existing, unambiguous Omni reference translate
deterministically — an ad-hoc aggregation with no backing named Metric is flagged untranslatable
exactly like Power BI's "implicit aggregate ... no explicit Omni measure to reference
deterministically" note, never guessed into a fake field. Native-SQL question cards have no MBQL to
resolve a topic/fields from at all, so they're always untranslatable at the tile level (raw SQL +
template tags as the hint) — never guessed into a fake topic, same tier as Tableau custom SQL.
"""

from __future__ import annotations

import re

from omni_migrator.deterministic.dashboard_maps import grid_from_metabase, metabase_chart_type
from omni_migrator.deterministic.mbql_translate import (
    FieldIndex,
    normalize_query_stage,
    resolve_field_ref,
    translate_filter_to_conditions,
)
from omni_migrator.ir.schema import DashboardIR, FilterIR, QueryIR, TileIR, UntranslatableNote


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", (text or "").strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _unwrap_aggregation(clause: object) -> object:
    if isinstance(clause, list) and clause and clause[0] == "aggregation-options" and len(clause) > 1:
        return clause[1]
    return clause


def _card_to_query(
    card: dict, field_index: FieldIndex, table_view: dict[int, str], metric_field_names: dict[int, str],
) -> tuple[QueryIR | None, list[UntranslatableNote]]:
    label = f"card «{card.get('name') or card.get('id')}»"
    dq = card.get("dataset_query") or {}
    is_native, query = normalize_query_stage(dq)

    if is_native:
        tags = list(query.get("template-tags", {}))
        hint = f"SQL: {(query.get('query') or '')[:300]}"
        if tags:
            hint += f"; template tags: {tags}"
        return None, [UntranslatableNote(
            object=label, severity="warning",
            reason="Native-SQL question; no MBQL to resolve a topic/fields from.", hint=hint,
        )]

    table_id = query.get("source-table")
    topic = table_view.get(table_id)
    if topic is None:
        return None, [UntranslatableNote(
            object=label, severity="warning", reason=f"Unknown/unmapped source-table {table_id!r}.",
        )]

    fields: list[str] = []
    notes: list[UntranslatableNote] = []

    for agg in query.get("aggregation", []):
        clause = _unwrap_aggregation(agg)
        if isinstance(clause, list) and len(clause) == 2 and clause[0] == "metric":
            metric_name = metric_field_names.get(clause[1])
            if metric_name:
                fields.append(metric_name)
                continue
        notes.append(UntranslatableNote(
            object=f"{label} aggregation", severity="warning", hint=str(agg),
            reason="Ad-hoc aggregation with no backing Omni measure field to reference "
            "deterministically — pick/create one (same posture as Power BI's implicit-aggregate tiles).",
        ))

    for ref in query.get("breakout", []):
        col, reason = resolve_field_ref(ref, field_index, table_id)
        if reason:
            notes.append(UntranslatableNote(object=f"{label} breakout", severity="info", hint=reason, reason=reason))
            continue
        fields.append(col)

    filters: list[FilterIR] = []
    if query.get("filter"):
        conds, reason = translate_filter_to_conditions(query["filter"], field_index, table_id)
        if reason:
            notes.append(UntranslatableNote(object=f"{label} filter", severity="info", hint=reason, reason=reason))
        else:
            filters = [FilterIR(field=f, operator=op, values=v, is_negative=neg) for f, op, v, neg in conds]

    sorts: list[dict] = []
    for ob in query.get("order-by", []):
        if not (isinstance(ob, list) and len(ob) == 2):
            continue
        direction, ref = ob
        col, reason = resolve_field_ref(ref, field_index, table_id)
        if reason:
            notes.append(UntranslatableNote(object=f"{label} sort", severity="info", hint=reason, reason=reason))
            continue
        sorts.append({"field": col, "direction": direction or "asc"})

    if not fields:
        notes.append(UntranslatableNote(
            object=label, severity="warning",
            reason="No field on this card resolved deterministically; not emitted (see notes above).",
        ))
        return None, notes

    native_id = str(card["id"]) if card.get("id") is not None else None
    return QueryIR(
        native_source_id=native_id,
        source_locator=f"query:card:{native_id}" if native_id else None,
        topic=topic, fields=fields, filters=filters, sorts=sorts, limit=query.get("limit"),
    ), notes


def _dashcard_to_tile(
    dc: dict, cards_by_id: dict[int, dict], field_index: FieldIndex,
    table_view: dict[int, str], metric_field_names: dict[int, str],
) -> tuple[TileIR | None, list[UntranslatableNote]]:
    layout = grid_from_metabase(dc.get("col", 0), dc.get("row", 0), dc.get("size_x", 4), dc.get("size_y", 4))
    vis = dc.get("visualization_settings") or {}
    virtual = vis.get("virtual_card")
    if virtual is not None:
        vtype = virtual.get("display")
        if vtype in ("text", "heading"):
            native_id = str(dc["id"]) if dc.get("id") is not None else None
            return TileIR(
                native_source_id=native_id,
                source_locator=f"dashcard:{native_id}" if native_id else None,
                kind="markdown", chart_type="markdown", vis_config={"body": vis.get("text", "")}, layout=layout,
            ), []
        return None, [UntranslatableNote(
            object=f"virtual card ({vtype})", severity="info",
            reason=f"Virtual card type '{vtype}' is not a data tile; not migrated.",
        )]

    card = dc.get("card") or cards_by_id.get(dc.get("card_id"))
    if card is None:
        return None, [UntranslatableNote(
            object=f"dashcard {dc.get('id')}", severity="warning", reason="Card not found for this dashcard.",
        )]

    label = card.get("name") or f"card {card.get('id')}"
    q_ir, notes = _card_to_query(card, field_index, table_view, metric_field_names)
    if q_ir is None:
        return None, notes

    display = card.get("display")
    chart = metabase_chart_type(display)
    if display and chart is None:
        notes.append(UntranslatableNote(
            object=label, severity="info", hint=display,
            reason=f"Unmapped Metabase display '{display}'; defaulted to table.",
        ))
        chart = "table"

    native_id = str(dc["id"]) if dc.get("id") is not None else None
    return TileIR(
        native_source_id=native_id,
        source_locator=f"dashcard:{native_id}" if native_id else None,
        kind="query", title=label, query=q_ir, chart_type=chart or "table", layout=layout,
    ), notes


def _parameter_to_filter(param: dict, mappings: list[dict], field_index: FieldIndex) -> FilterIR:
    """Dashboard `parameters[]` -> a default-value `FilterIR`, same "default" placeholder posture
    Looker/Power BI's dashboard translators already use for widget-level filters (not a full query
    filter clause — Metabase's own `parameter_mappings` wiring to specific cards is per-tile detail
    this dashboard-wide filter list doesn't carry, matching `FilterIR`'s existing shape)."""
    field_name = _snake(param.get("name") or param.get("slug") or "")
    for m in mappings:
        if m.get("parameter_id") != param.get("id"):
            continue
        target = m.get("target")
        if isinstance(target, list) and len(target) == 2 and target[0] == "dimension":
            ref = target[1]
            if isinstance(ref, list) and len(ref) >= 2 and ref[0] == "field" and isinstance(ref[1], int):
                meta = field_index.get(ref[1])
                if meta:
                    field_name = meta.name
                    break
    default = param.get("default")
    values = [str(v) for v in default] if isinstance(default, list) else ([str(default)] if default is not None else [])
    native_id = str(param["id"]) if param.get("id") is not None else None
    return FilterIR(
        native_source_id=native_id,
        source_locator=f"parameter:{native_id}" if native_id else None,
        field=field_name, operator="default", values=values,
    )


def translate_metabase_dashboard(
    dash: dict,
    *,
    cards_by_id: dict[int, dict] | None = None,
    field_index: FieldIndex | None = None,
    table_view: dict[int, str] | None = None,
    metric_field_names: dict[int, str] | None = None,
    source_url: str | None = None,
) -> DashboardIR:
    cards_by_id = cards_by_id or {}
    field_index = field_index or {}
    table_view = table_view or {}
    metric_field_names = metric_field_names or {}

    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = []
    for dc in dash.get("dashcards", []):
        tile, tile_notes = _dashcard_to_tile(dc, cards_by_id, field_index, table_view, metric_field_names)
        if tile:
            tiles.append(tile)
        notes.extend(tile_notes)

    mappings = [m for dc in dash.get("dashcards", []) for m in (dc.get("parameter_mappings") or [])]
    filters = [_parameter_to_filter(p, mappings, field_index) for p in dash.get("parameters", [])]

    native_id = str(dash["id"]) if dash.get("id") is not None else None
    return DashboardIR(
        native_source_id=native_id,
        selection_aliases=[native_id] if native_id else [],
        source_locator=f"dashboard:{native_id}" if native_id else None,
        name=dash.get("name") or "dashboard", tiles=tiles, filters=filters,
        source_url=source_url, untranslatable=notes,
    )

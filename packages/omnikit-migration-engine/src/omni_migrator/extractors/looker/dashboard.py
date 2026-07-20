"""Looker dashboard JSON (GET /api/4.0/dashboards/{id}) -> DashboardIR.

Deterministic translation of layout, tiles, queries, and filters (plan §6.3, A.10).
Untranslatable elements (merge queries, custom viz, unknown vis) are flagged, not dropped.
"""

from __future__ import annotations

from omni_migrator.deterministic.dashboard_maps import grid_from_24, looker_chart_type
from omni_migrator.ir.schema import (
    DashboardIR,
    FilterIR,
    GridRect,
    QueryIR,
    TileIR,
    UntranslatableNote,
)


def _layout_index(dash: dict) -> dict[str, dict]:
    """element_id -> {row, column, width, height} from the dashboard layout."""
    out: dict[str, dict] = {}
    for layout in dash.get("dashboard_layouts", []) or []:
        for comp in layout.get("dashboard_layout_components", []) or []:
            eid = comp.get("dashboard_element_id")
            if eid is not None:
                out[str(eid)] = comp
    return out


def _query_to_ir(q: dict) -> QueryIR:
    filters = [
        FilterIR(field=dim, operator="looker_expr", values=[str(expr)])
        for dim, expr in (q.get("filters") or {}).items()
    ]
    return QueryIR(
        native_source_id=str(q["id"]) if q.get("id") is not None else None,
        source_locator=f"query:{q['id']}" if q.get("id") is not None else None,
        topic=q.get("view") or q.get("explore") or q.get("model") or "",
        fields=list(q.get("fields") or []),
        filters=filters,
        sorts=[{"field": s} for s in (q.get("sorts") or [])],
        limit=int(q["limit"]) if q.get("limit") not in (None, "") else None,
        pivots=list(q.get("pivots")) if q.get("pivots") else None,
    )


def _element_to_tile(el: dict, layout: dict[str, dict]):
    eid = str(el.get("id"))
    comp = layout.get(eid, {})
    rect = (
        grid_from_24(comp.get("column", 0), comp.get("row", 0), comp.get("width", 8), comp.get("height", 4))
        if comp
        else GridRect()
    )
    title = el.get("title") or el.get("title_text")

    if el.get("merge_result_id"):
        return None, UntranslatableNote(
            object=f"tile {title or eid}", severity="warning",
            reason="Merged-results tile has no Omni equivalent; rebuild manually.",
        )

    el_type = el.get("type")
    if el_type in ("text", "note") or el.get("body_text") or el.get("text_as_html"):
        return TileIR(
            native_source_id=eid, source_locator=f"tile:{eid}",
            kind="markdown", title=title, chart_type="markdown",
            vis_config={"body": el.get("body_text") or el.get("text_as_html") or ""},
            layout=rect,
        ), None

    query = el.get("query") or (el.get("result_maker") or {}).get("query")
    if not query:
        return None, UntranslatableNote(
            object=f"tile {title or eid}", severity="warning",
            reason=f"Element type '{el_type}' has no translatable query.",
        )

    vis_type = (el.get("vis_config") or {}).get("type")
    chart = looker_chart_type(vis_type)
    note = None
    if vis_type and chart is None:
        note = UntranslatableNote(
            object=f"tile {title or eid}", severity="info", hint=vis_type,
            reason=f"Unmapped Looker vis '{vis_type}'; defaulted to table.",
        )
        chart = "table"
    return TileIR(
        native_source_id=eid, source_locator=f"tile:{eid}",
        kind="query", title=title, query=_query_to_ir(query),
        chart_type=chart, layout=rect,
    ), note


def _dashboard_filter(f: dict) -> FilterIR:
    native_id = f.get("id") or f.get("name")
    return FilterIR(
        native_source_id=str(native_id) if native_id is not None else None,
        source_locator=f"filter:{native_id}" if native_id is not None else None,
        field=f.get("dimension") or f.get("name") or "",
        operator="default",
        values=[str(f["default_value"])] if f.get("default_value") not in (None, "") else [],
    )


def translate_looker_dashboard(dash: dict) -> DashboardIR:
    layout = _layout_index(dash)
    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = []
    for el in dash.get("dashboard_elements", []) or []:
        tile, note = _element_to_tile(el, layout)
        if tile:
            tiles.append(tile)
        if note:
            notes.append(note)
    filters = [_dashboard_filter(f) for f in dash.get("dashboard_filters", []) or []]
    native_id = str(dash["id"]) if dash.get("id") is not None else None
    return DashboardIR(
        native_source_id=native_id,
        selection_aliases=[native_id] if native_id else [],
        source_locator=f"dashboard:{native_id}" if native_id else None,
        name=dash.get("title") or f"dashboard {dash.get('id')}",
        tiles=tiles,
        filters=filters,
        source_url=dash.get("url"),
        untranslatable=notes,
    )


def translate_looker_dashboard_lookml(dash: dict) -> DashboardIR:
    """Translate one parsed LookML dashboard block into DashboardIR.

    Dashboard LookML is YAML-like rather than standard LookML syntax. Layout metadata is
    optional, so elements without explicit coordinates are stacked deterministically and
    left visible for human layout review instead of being discarded.
    """
    filters = [
        FilterIR(
            field=str(item.get("field") or item.get("name") or ""),
            operator="default",
            values=[str(item["default_value"])] if item.get("default_value") not in (None, "") else [],
        )
        for item in (dash.get("filters") or [])
        if isinstance(item, dict)
    ]
    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = []
    for index, element in enumerate(dash.get("elements") or []):
        if not isinstance(element, dict):
            continue
        title = element.get("title") or element.get("name") or f"Tile {index + 1}"
        vis_type = element.get("type")
        chart_type = looker_chart_type(vis_type)
        if chart_type is None:
            chart_type = "table"
            notes.append(UntranslatableNote(
                object=f"tile {title}",
                reason=f"Unmapped dashboard LookML visualization '{vis_type}'; defaulted to table.",
                severity="info",
            ))
        width = int(element.get("width") or 24)
        height = int(element.get("height") or 4)
        row = int(element.get("row") or index * height)
        column = int(element.get("column") or 0)
        layout = grid_from_24(column, row, width, height)
        if vis_type == "text" or element.get("body_text"):
            tiles.append(TileIR(
                kind="markdown",
                title=title,
                chart_type="markdown",
                vis_config={"body": element.get("body_text") or ""},
                layout=layout,
            ))
            continue
        query_filters = [
            FilterIR(field=str(field), operator="looker_expr", values=[str(value)])
            for field, value in (element.get("filters") or {}).items()
        ] if isinstance(element.get("filters"), dict) else []
        tiles.append(TileIR(
            kind="query",
            title=title,
            query=QueryIR(
                topic=str(element.get("explore") or element.get("model") or ""),
                fields=[str(field) for field in (element.get("fields") or [])],
                filters=query_filters,
                sorts=[{"field": str(sort)} for sort in (element.get("sorts") or [])],
                limit=int(element["limit"]) if element.get("limit") not in (None, "") else None,
                pivots=[str(pivot) for pivot in (element.get("pivots") or [])] or None,
            ),
            chart_type=chart_type,
            vis_config={"listen": element.get("listen") or {}},
            layout=layout,
        ))
    native_id = str(dash.get("dashboard") or "").strip() or None
    return DashboardIR(
        native_source_id=native_id,
        selection_aliases=[native_id] if native_id else [],
        source_locator=f"dashboard:{native_id}" if native_id else None,
        name=str(dash.get("title") or dash.get("dashboard") or "Looker dashboard"),
        tiles=tiles,
        filters=filters,
        source_url=dash.get("url"),
        untranslatable=notes,
    )

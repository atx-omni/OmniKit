"""Looker dashboard JSON (GET /api/4.0/dashboards/{id}) -> DashboardIR.

Deterministic translation of layout, tiles, queries, and filters (plan §6.3, A.10).
Untranslatable elements (merge queries, custom viz, unknown vis) are flagged, not dropped.
"""

from __future__ import annotations

import json
import re

from omni_migrator.deterministic.dashboard_maps import grid_from_24, looker_chart_type
from omni_migrator.ir.schema import (
    DashboardIR,
    DynamicFieldIR,
    FilterIR,
    FilterBindingIR,
    GridRect,
    QueryIR,
    TileIR,
    UntranslatableNote,
)


_FIELD_REFERENCE = re.compile(r"\$\{([^}]+)\}")


def _string_dict(value) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items()}


def _dynamic_fields(raw, topic: str) -> list[DynamicFieldIR]:
    if raw in (None, "", []):
        return []
    parsed = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = [{"name": "unparsed_dynamic_field", "raw": raw}]
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        parsed = [{"name": "unparsed_dynamic_field", "raw": str(parsed)}]

    out: list[DynamicFieldIR] = []
    for index, item in enumerate(parsed):
        if not isinstance(item, dict):
            item = {"name": f"dynamic_field_{index + 1}", "raw": str(item)}
        source_category = str(item.get("category") or "").lower()
        expression = item.get("expression") or item.get("sql")
        expression_text = str(expression) if expression not in (None, "") else None
        filters = _string_dict(item.get("filters"))
        based_on = item.get("based_on")
        based_on_text = str(based_on) if based_on not in (None, "") else None
        if source_category in ("dimension", "group_by"):
            category = "group_by"
        elif source_category == "measure" and (filters or based_on_text):
            category = "filtered_measure"
        elif source_category in ("table_calculation", "table_calc"):
            category = "table_calculation"
        elif expression_text:
            category = "expression"
        else:
            category = "unknown"
        name = str(
            item.get("dimension") or item.get("measure") or item.get("table_calculation")
            or item.get("name") or item.get("label") or f"dynamic_field_{index + 1}"
        )
        dependencies = sorted(set([
            *(_FIELD_REFERENCE.findall(expression_text or "")),
            *([based_on_text] if based_on_text else []),
            *filters.keys(),
        ]))
        if category == "group_by":
            support_outcome = "automatic"
        elif category == "filtered_measure":
            same_view = bool(topic) and all(field.startswith(f"{topic}.") for field in filters)
            support_outcome = "automatic" if same_view else "decision_required"
        elif category in ("table_calculation", "expression"):
            support_outcome = "decision_required"
        else:
            support_outcome = "unsupported"
        out.append(DynamicFieldIR(
            native_source_id=name,
            source_locator=f"dynamic_field:{name}",
            name=name,
            label=str(item.get("label")) if item.get("label") not in (None, "") else None,
            category=category,
            expression=expression_text,
            based_on=based_on_text,
            filters=filters,
            dependencies=dependencies,
            support_outcome=support_outcome,
            config=dict(item),
        ))
    return out


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
    topic = q.get("view") or q.get("explore") or q.get("model") or ""
    dynamic_fields = _dynamic_fields(q.get("dynamic_fields"), topic)
    return QueryIR(
        native_source_id=str(q["id"]) if q.get("id") is not None else None,
        source_locator=f"query:{q['id']}" if q.get("id") is not None else None,
        topic=topic,
        fields=list(q.get("fields") or []),
        filters=filters,
        sorts=[{"field": s} for s in (q.get("sorts") or [])],
        limit=int(q["limit"]) if q.get("limit") not in (None, "") else None,
        pivots=list(q.get("pivots")) if q.get("pivots") else None,
        source_model=q.get("model"),
        source_explore=q.get("explore") or q.get("view"),
        filter_expression=q.get("filter_expression"),
        hidden_fields=[str(item) for item in (q.get("hidden_fields") or [])],
        dynamic_fields=dynamic_fields,
        calculation_dependencies=sorted(set(
            dependency for item in dynamic_fields for dependency in item.dependencies
        )),
        query_origin=str(q.get("_omnikit_query_origin") or "unknown"),
        source_look_id=(
            str(q["_omnikit_source_look_id"])
            if q.get("_omnikit_source_look_id") not in (None, "") else None
        ),
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
        note = UntranslatableNote(
            object=f"tile {title or eid}", severity="warning",
            reason="Merged-results tile has no Omni equivalent; rebuild manually.",
        )
        vis_type = (el.get("vis_config") or {}).get("type")
        return TileIR(
            native_source_id=eid, source_locator=f"tile:{eid}",
            kind="query", title=title, chart_type=looker_chart_type(vis_type) or "table",
            vis_config=dict(el.get("vis_config") or {}), layout=rect,
            untranslatable=[note],
        ), None

    el_type = el.get("type")
    if el_type in ("text", "note") or el.get("body_text") or el.get("text_as_html"):
        return TileIR(
            native_source_id=eid, source_locator=f"tile:{eid}",
            kind="markdown", title=title, chart_type="markdown",
            vis_config={"body": el.get("body_text") or el.get("text_as_html") or ""},
            layout=rect,
        ), None

    embedded_look = el.get("look") if isinstance(el.get("look"), dict) else {}
    if isinstance(el.get("_omnikit_resolved_query"), dict):
        query = dict(el["_omnikit_resolved_query"])
        query.setdefault("_omnikit_query_origin", el.get("_omnikit_query_origin") or "unknown")
        query.setdefault("_omnikit_source_look_id", el.get("_omnikit_source_look_id"))
    elif isinstance(el.get("query"), dict):
        query = dict(el["query"])
        query.setdefault("_omnikit_query_origin", "inline")
    elif isinstance((el.get("result_maker") or {}).get("query"), dict):
        query = dict((el.get("result_maker") or {})["query"])
        query.setdefault("_omnikit_query_origin", "result_maker")
    elif isinstance(embedded_look.get("query"), dict):
        query = dict(embedded_look["query"])
        query.setdefault("_omnikit_query_origin", "saved_look")
        query.setdefault("_omnikit_source_look_id", embedded_look.get("id") or el.get("look_id"))
    else:
        query = None
    if not query:
        look_id = el.get("look_id") or embedded_look.get("id")
        query_id = el.get("query_id") or embedded_look.get("query_id")
        reference = f" saved Look {look_id}" if look_id else f" query {query_id}" if query_id else ""
        note = UntranslatableNote(
            object=f"tile {title or eid}", severity="blocker",
            reason=f"Element type '{el_type}' has no resolved query{reference}; provide the missing source evidence before migration.",
        )
        return TileIR(
            native_source_id=eid, source_locator=f"tile:{eid}",
            kind="query", title=title, chart_type="table",
            vis_config=dict(el.get("vis_config") or {}), layout=rect,
            untranslatable=[note],
        ), None

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
        chart_type=chart, vis_config=dict(el.get("vis_config") or {}), layout=rect,
    ), note


def _dashboard_filter(f: dict) -> FilterIR:
    native_id = f.get("id") or f.get("name")
    return FilterIR(
        native_source_id=str(native_id) if native_id is not None else None,
        source_locator=f"filter:{native_id}" if native_id is not None else None,
        field=f.get("dimension") or f.get("name") or "",
        operator="default",
        values=[str(f["default_value"])] if f.get("default_value") not in (None, "") else [],
        label=f.get("title") or f.get("name"),
        filter_type=f.get("type"),
        required=bool(f.get("required")),
    )


def _listen_map(element: dict) -> dict[str, str]:
    result: dict[str, str] = {}
    result_maker = element.get("result_maker") or {}
    for filterable in result_maker.get("filterables") or []:
        if not isinstance(filterable, dict):
            continue
        result.update(_string_dict(filterable.get("listen")))
    result.update(_string_dict(element.get("listen")))
    return result


def _filter_bindings(filters: list[FilterIR], tiles: list[TileIR], elements: list[dict]) -> list[FilterBindingIR]:
    listens = {str(element.get("id")): _listen_map(element) for element in elements}
    bindings: list[FilterBindingIR] = []
    for filter_item in filters:
        filter_id = str(filter_item.native_source_id or filter_item.label or filter_item.field)
        filter_label = str(filter_item.label or filter_item.field)
        for tile in tiles:
            tile_id = str(tile.native_source_id or tile.title or "tile")
            listen = listens.get(tile_id, {})
            target_field = listen.get(filter_label) or listen.get(filter_id) or listen.get(filter_item.field)
            bindings.append(FilterBindingIR(
                native_source_id=f"{filter_id}:{tile_id}",
                source_locator=f"filter_binding:{filter_id}:{tile_id}",
                dashboard_filter_id=filter_id,
                dashboard_filter_label=filter_label,
                tile_id=tile_id,
                target_field=target_field,
                excluded=not bool(target_field),
            ))
    return bindings


def translate_looker_dashboard(dash: dict) -> DashboardIR:
    layout = _layout_index(dash)
    elements = [item for item in (dash.get("dashboard_elements") or []) if isinstance(item, dict)]
    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = []
    for el in elements:
        tile, note = _element_to_tile(el, layout)
        if tile:
            tiles.append(tile)
        if note:
            notes.append(note)
    filters = [_dashboard_filter(f) for f in dash.get("dashboard_filters", []) or []]
    ordered_tiles = sorted(tiles, key=lambda item: (item.layout.y, item.layout.x, item.title or ""))
    native_id = str(dash["id"]) if dash.get("id") is not None else None
    folder = dash.get("folder") if isinstance(dash.get("folder"), dict) else {}
    user = dash.get("user") if isinstance(dash.get("user"), dict) else {}
    return DashboardIR(
        native_source_id=native_id,
        selection_aliases=[native_id] if native_id else [],
        source_locator=f"dashboard:{native_id}" if native_id else None,
        name=dash.get("title") or f"dashboard {dash.get('id')}",
        tiles=ordered_tiles,
        filters=filters,
        filter_bindings=_filter_bindings(filters, ordered_tiles, elements),
        filter_order=[str(item.native_source_id or item.label or item.field) for item in filters],
        tile_order=[str(item.native_source_id or item.title or "tile") for item in ordered_tiles],
        folder_path=folder.get("name") or dash.get("folder_path"),
        owner=dash.get("user_name") or user.get("display_name"),
        updated_at=dash.get("updated_at"),
        usage_count=int(dash.get("view_count")) if str(dash.get("view_count") or "").isdigit() else None,
        source_url=dash.get("url"),
        untranslatable=notes,
    )


def translate_looker_dashboard_lookml(
    dash: dict,
    saved_looks: dict[str, dict] | None = None,
) -> DashboardIR:
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
            label=str(item.get("title") or item.get("name") or item.get("field") or ""),
            filter_type=str(item.get("type")) if item.get("type") not in (None, "") else None,
            required=bool(item.get("required")),
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
        saved_looks = saved_looks or {}
        look_id = str(element.get("look_id") or "").strip()
        saved_look = saved_looks.get(look_id) if look_id else None
        visual_config = {
            str(key): value for key, value in element.items()
            if key not in {"name", "title", "explore", "model", "fields", "filters", "sorts", "limit", "pivots", "row", "column", "width", "height"}
        }
        visual_config["listen"] = element.get("listen") or {}
        inline_query_available = bool(
            element.get("model") or element.get("explore") or element.get("fields")
        )
        if inline_query_available:
            query_payload = {
                "model": element.get("model"),
                "explore": element.get("explore"),
                "view": element.get("explore"),
                "fields": element.get("fields") or [],
                "filters": element.get("filters") or {},
                "sorts": element.get("sorts") or [],
                "limit": element.get("limit"),
                "pivots": element.get("pivots") or [],
                "filter_expression": element.get("filter_expression"),
                "hidden_fields": element.get("hidden_fields") or [],
                "dynamic_fields": element.get("dynamic_fields") or [],
                "_omnikit_query_origin": "inline",
            }
        elif isinstance(saved_look, dict) and isinstance(saved_look.get("query"), dict):
            query_payload = dict(saved_look["query"])
            query_payload["_omnikit_query_origin"] = "saved_look"
            query_payload["_omnikit_source_look_id"] = look_id
        else:
            query_payload = None
        tile_notes: list[UntranslatableNote] = []
        if query_payload is None:
            tile_notes.append(UntranslatableNote(
                object=f"tile {title}",
                severity="blocker",
                reason=(
                    f"Dashboard tile references saved Look {look_id}, but its companion Look JSON is missing."
                    if look_id else "Dashboard tile has no inline or saved-Look query evidence."
                ),
            ))
        tiles.append(TileIR(
            kind="query",
            title=title,
            query=_query_to_ir(query_payload) if query_payload is not None else None,
            chart_type=chart_type,
            vis_config=visual_config,
            layout=layout,
            untranslatable=tile_notes,
        ))
    native_id = str(dash.get("dashboard") or "").strip() or None
    for index, tile in enumerate(tiles):
        if not tile.native_source_id:
            tile.native_source_id = str((dash.get("elements") or [])[index].get("name") or f"tile-{index + 1}")
    bindings = _filter_bindings(filters, tiles, [
        {"id": tile.native_source_id, "listen": (dash.get("elements") or [])[index].get("listen") or {}}
        for index, tile in enumerate(tiles)
    ])
    ordered_tiles = sorted(tiles, key=lambda item: (item.layout.y, item.layout.x, item.title or ""))
    return DashboardIR(
        native_source_id=native_id,
        selection_aliases=[native_id] if native_id else [],
        source_locator=f"dashboard:{native_id}" if native_id else None,
        name=str(dash.get("title") or dash.get("dashboard") or "Looker dashboard"),
        tiles=ordered_tiles,
        filters=filters,
        filter_bindings=bindings,
        filter_order=[str(item.native_source_id or item.label or item.field) for item in filters],
        tile_order=[str(item.native_source_id or item.title or "tile") for item in ordered_tiles],
        folder_path=dash.get("folder"),
        source_url=dash.get("url"),
        untranslatable=notes,
    )

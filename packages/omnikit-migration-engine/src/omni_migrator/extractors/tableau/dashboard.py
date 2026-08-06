"""Tableau worksheet and dashboard evidence -> ``DashboardIR``.

Tableau officially documents workbook concepts, actions, filters, parameters, and dashboard
layout behavior, and publishes an official XSD baseline for current TWB versions. XSD validation
does not prove workbook semantics, however, and this parser does not claim Tableau REST semantic
validation. It preserves observed XML evidence and deterministic locators while treating
behavioral translation as review work. Filter/control definitions are inventoried, actions remain
unsupported, and source geometry is retained alongside an approximate 12-column projection with
no pixel-parity claim.

One `.twb`/`.twbx` can contain multiple `<dashboard>` elements; each becomes its own
`DashboardIR` (same granularity as one Power BI report page or one Looker dashboard).

A worksheet's Omni **topic** isn't given anywhere in its own XML the way Looker's `query.view`
or a Metabase card's `source-table` is — the closest available signal is the worksheet's bound
`<datasources><datasource caption=...>`, snake-cased the same way the model extractor derives
view/topic names from a datasource's `formatted-name`. Treat this as a same-run consistency
convention (it lines up with `extractors/tableau/extractor.py` when both run against the same
workbook), not a verified Omni-side fact.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from collections import Counter

from omni_migrator.deterministic.dashboard_maps import grid_from_tableau_zone, tableau_chart_type
from omni_migrator.extractors.tableau.extractor import (
    _formula_references,
    _is_lod_formula,
    _is_table_calculation,
    _load_root,
)
from omni_migrator.ir.identity import stable_source_id
from omni_migrator.ir.schema import (
    DashboardIR,
    DynamicFieldIR,
    FilterIR,
    QueryIR,
    SemanticRequirementIR,
    TileIR,
    UntranslatableNote,
)

load_workbook_root = _load_root  # re-exported: shared .twb/.twbx (zip-aware) XML loader

# `[datasource].[agg:FieldName:role]` — a shelf's "column instance" reference syntax.
_SHELF_REF = re.compile(r"\[[^\]]*\]\.\[(\w+):([^:\]]+):\w+\]")
_SHELF_AGG = {"sum", "avg", "cnt", "cntd", "min", "max", "median", "none"}


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", (text or "").strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _strip_brackets(s: str | None) -> str:
    return (s or "").strip().strip("[]")


class _Worksheet:
    def __init__(
        self,
        name: str,
        mark: str | None,
        rows: str,
        cols: str,
        field_captions: dict[str, str],
        topic: str | None,
        source_locator: str,
        filters: list[FilterIR],
        dynamic_fields: list[DynamicFieldIR],
        calculation_dependencies: list[str],
        notes: list[UntranslatableNote],
    ):
        self.name = name
        self.mark = mark
        self.rows = rows
        self.cols = cols
        self.field_captions = field_captions
        self.topic = topic
        self.source_locator = source_locator
        self.filters = filters
        self.dynamic_fields = dynamic_fields
        self.calculation_dependencies = calculation_dependencies
        self.notes = notes


def _identity(value, kind: str, locator: str):
    value.source_locator = locator
    value.source_id = stable_source_id("tableau", kind, locator)
    return value


def _worksheet_topic(view: ET.Element | None) -> str | None:
    ds = view.find("datasources/datasource") if view is not None else None
    if ds is None:
        return None
    return _snake(ds.get("caption") or ds.get("name") or "")


def _field_from_reference(reference: str | None, field_captions: dict[str, str]) -> str:
    if not reference:
        return "unresolved_filter"
    matches = _SHELF_REF.findall(reference)
    if matches:
        raw_name = matches[-1][1]
    else:
        bracketed = re.findall(r"\[([^\]]+)\]", reference)
        raw_name = bracketed[-1] if bracketed else reference
    caption = field_captions.get(_strip_brackets(raw_name), _strip_brackets(raw_name))
    return _snake(caption)


def _filter_values(filter_element: ET.Element) -> list[str]:
    values: list[str] = []
    for element in filter_element.iter():
        for key in ("member", "value", "filter"):
            value = element.get(key)
            if value is not None and value not in values:
                values.append(value)
    return values


def _worksheet_filter(
    filter_element: ET.Element,
    *,
    worksheet_locator: str,
    field_captions: dict[str, str],
    index: int,
) -> FilterIR:
    reference = filter_element.get("column") or filter_element.get("field")
    function_names = {
        (element.get("function") or "").lower()
        for element in filter_element.iter()
        if element.get("function")
    }
    locator = f"{worksheet_locator}/filter:{reference or index}"
    return _identity(
        FilterIR(
            field=_field_from_reference(reference, field_captions),
            operator="source_definition",
            values=_filter_values(filter_element),
            is_negative=bool(function_names & {"except", "exclude"}),
            filter_type=filter_element.get("class") or "worksheet",
        ),
        "filter",
        locator,
    )


def _worksheet_calculation(
    column: ET.Element,
    formula: str,
    *,
    worksheet_locator: str,
) -> tuple[DynamicFieldIR, UntranslatableNote]:
    caption = column.get("caption") or _strip_brackets(column.get("name")) or "calculation"
    locator = f"{worksheet_locator}/calculation:{column.get('name') or caption}"
    if _is_table_calculation(formula):
        category = "table_calculation"
        support_outcome = "unsupported"
        reason = (
            "Worksheet table calculation remains unsupported; partitioning, addressing, sort "
            "order, and visible-mark context are not inferred."
        )
    elif _is_lod_formula(formula):
        category = "expression"
        support_outcome = "unsupported"
        reason = (
            "Worksheet LOD calculation remains unsupported; declared granularity and Tableau "
            "filter order require an explicit target design."
        )
    else:
        category = "expression"
        support_outcome = "decision_required"
        reason = (
            "Worksheet calculation is preserved as source evidence only; placement in a model, "
            "query view, or dashboard query requires a reviewed decision."
        )
    references = [_snake(item) for item in _formula_references(formula)]
    dynamic = _identity(
        DynamicFieldIR(
            name=_snake(caption),
            label=caption,
            category=category,
            expression=formula,
            dependencies=references,
            support_outcome=support_outcome,
            config={
                "scope": "worksheet",
                "source_field_name": column.get("name"),
                "source_role": column.get("role"),
                "source_datatype": column.get("datatype"),
            },
        ),
        "dynamic_field",
        locator,
    )
    return dynamic, UntranslatableNote(
        object=f"worksheet calculation {caption}",
        severity="blocker" if support_outcome == "unsupported" else "warning",
        hint=formula,
        reason=reason,
    )


def _worksheet_index(
    root: ET.Element,
    *,
    artifact_key: str = "tableau-artifact",
) -> dict[str, _Worksheet]:
    out: dict[str, _Worksheet] = {}
    for ws in root.iter("worksheet"):
        name = ws.get("name")
        table = ws.find("table")
        if not name or table is None:
            continue
        view = table.find("view")
        worksheet_locator = f"artifact:{artifact_key}/worksheet:{name}"
        field_captions: dict[str, str] = {}
        dynamic_fields: list[DynamicFieldIR] = []
        calculation_dependencies: list[str] = []
        notes: list[UntranslatableNote] = []
        if view is not None:
            for dep in view.findall("datasource-dependencies"):
                for col in dep.findall("column"):
                    cname = _strip_brackets(col.get("name"))
                    if cname:
                        field_captions[cname] = col.get("caption") or cname
                    calculation = col.find("calculation")
                    formula = calculation.get("formula") if calculation is not None else None
                    if formula:
                        dynamic, note = _worksheet_calculation(
                            col,
                            formula,
                            worksheet_locator=worksheet_locator,
                        )
                        dynamic_fields.append(dynamic)
                        calculation_dependencies.append(dynamic.name)
                        notes.append(note)
        mark = None
        panes = table.find("panes")
        if panes is not None:
            mark_el = panes.find(".//mark")
            if mark_el is not None:
                mark = mark_el.get("class")
        filters = [
            _worksheet_filter(
                filter_element,
                worksheet_locator=worksheet_locator,
                field_captions=field_captions,
                index=index,
            )
            for index, filter_element in enumerate(table.findall(".//filter"))
        ]
        if filters:
            notes.append(UntranslatableNote(
                object=f"worksheet {name!r} filters",
                severity="blocker",
                reason=(
                    "Worksheet filter definitions are preserved as source evidence, but context, "
                    "scope, order of operations, and target behavior are not automatically emitted."
                ),
            ))
        out[name] = _Worksheet(
            name=name, mark=mark,
            rows=table.findtext("rows") or "", cols=table.findtext("cols") or "",
            field_captions=field_captions,
            topic=_worksheet_topic(view),
            source_locator=worksheet_locator,
            filters=filters,
            dynamic_fields=dynamic_fields,
            calculation_dependencies=calculation_dependencies,
            notes=notes,
        )
    return out


def _parse_shelf(text: str, field_captions: dict[str, str]) -> tuple[list[str], bool, list[str]]:
    """One shelf's raw text -> (breakout field names, has_aggregated_measure, unmapped-agg notes)."""
    fields: list[str] = []
    has_measure = False
    notes: list[str] = []
    for agg, fname in _SHELF_REF.findall(text):
        caption = field_captions.get(_strip_brackets(fname), fname)
        name = _snake(caption)
        if agg and agg != "none":
            if agg in _SHELF_AGG:
                has_measure = True
                fields.append(name)
            else:
                notes.append(f"unmapped shelf aggregation code {agg!r} on {caption!r}")
        else:
            fields.append(name)
    return fields, has_measure, notes


def _worksheet_query(ws: _Worksheet) -> tuple[QueryIR | None, list[UntranslatableNote], bool]:
    """-> (query, notes, measure_on_cols) for chart-type orientation (Bar vs. Column)."""
    row_fields, row_has_measure, row_notes = _parse_shelf(ws.rows, ws.field_captions)
    col_fields, col_has_measure, col_notes = _parse_shelf(ws.cols, ws.field_captions)
    label = f"worksheet {ws.name!r}"
    notes = [
        UntranslatableNote(object=f"{label} shelf", severity="info", reason=n)
        for n in row_notes + col_notes
    ] + list(ws.notes)

    if not ws.topic:
        notes.append(UntranslatableNote(
            object=label, severity="warning",
            reason="Could not determine the worksheet's bound datasource; no topic to query against.",
        ))
        return None, notes, col_has_measure

    fields = row_fields + col_fields
    if not fields:
        notes.append(UntranslatableNote(
            object=label, severity="warning",
            reason="No rows/cols shelf fields resolved deterministically.",
        ))
        return None, notes, col_has_measure

    if row_has_measure and col_has_measure:
        notes.append(UntranslatableNote(
            object=label, severity="info",
            reason="Both shelves carry an aggregated measure (dual-axis/combo chart?); "
                   "chart-type orientation below is a guess.",
        ))

    query_locator = f"{ws.source_locator}/query"
    return _identity(
        QueryIR(
            native_source_id=ws.name,
            topic=ws.topic,
            fields=fields,
            filters=ws.filters,
            dynamic_fields=ws.dynamic_fields,
            calculation_dependencies=ws.calculation_dependencies,
            query_origin="unknown",
        ),
        "query",
        query_locator,
    ), notes, col_has_measure


def _text_from_zone(zone: ET.Element) -> str | None:
    """Best-effort extraction from two observed fixture shapes; returns no guessed content."""
    ft = zone.find("formatted-text")
    if ft is not None:
        runs = [r.text for r in ft.iter("run") if r.text]
        if runs:
            return "".join(runs)
    zs = zone.find("zone-style")
    if zs is not None:
        for fmt in zs.findall("format"):
            if fmt.get("attr") == "text" and fmt.get("value"):
                return fmt.get("value")
    return None


def _int_attribute(element: ET.Element | None, attribute: str, default: int = 0) -> int:
    if element is None or element.get(attribute) is None:
        return default
    try:
        return int(float(element.get(attribute) or default))
    except ValueError:
        return default


def _zone_rect(zone: ET.Element, canvas_w: int, canvas_h: int):
    return grid_from_tableau_zone(
        _int_attribute(zone, "x"),
        _int_attribute(zone, "y"),
        _int_attribute(zone, "w"),
        _int_attribute(zone, "h"),
        canvas_w, canvas_h,
    )


def _zone_locator(dashboard_locator: str, zone: ET.Element) -> str:
    key = (
        zone.get("id")
        or zone.get("name")
        or ":".join(
            str(zone.get(item) or "") for item in ("type-v2", "x", "y", "w", "h")
        )
        or "anonymous"
    )
    return f"{dashboard_locator}/zone:{key}"


def _layout_evidence(
    zone: ET.Element,
    *,
    canvas_w: int,
    canvas_h: int,
    projected,
) -> dict:
    return {
        "tableau_layout": {
            "zone_id": zone.get("id"),
            "zone_type": zone.get("type-v2"),
            "layout_mode": zone.get("mode") or zone.get("layout"),
            "source_rect": {
                item: _int_attribute(zone, item) if zone.get(item) is not None else None
                for item in ("x", "y", "w", "h")
            },
            "source_dashboard_size": {"width": canvas_w, "height": canvas_h},
            "projected_grid": projected.model_dump(mode="json"),
            "projection": "approximate_12_column_grid",
            "pixel_parity": False,
        },
    }


def _zone_to_tiles(
    zone: ET.Element,
    worksheets: dict[str, _Worksheet],
    canvas_w: int,
    canvas_h: int,
    dashboard_locator: str,
) -> tuple[list[TileIR], list[UntranslatableNote]]:
    name = zone.get("name")
    children = zone.findall("zone")
    zone_locator = _zone_locator(dashboard_locator, zone)

    if name and name in worksheets:
        ws = worksheets[name]
        q, notes, measure_on_cols = _worksheet_query(ws)
        if q is None:
            return [], notes
        chart = tableau_chart_type(ws.mark, measure_on_cols=measure_on_cols)
        if ws.mark and chart is None:
            notes.append(UntranslatableNote(
                object=f"worksheet {ws.name!r}",
                severity="blocker",
                hint=ws.mark,
                reason=(
                    f"Unmapped Tableau mark {ws.mark!r}; chart type is intentionally unset "
                    "pending an explicit visualization review."
                ),
            ))
        rect = _zone_rect(zone, canvas_w, canvas_h)
        if any(zone.get(item) is None for item in ("x", "y", "w", "h")):
            notes.append(UntranslatableNote(
                object=f"worksheet zone {ws.name!r} layout",
                severity="blocker",
                reason=(
                    "Source zone geometry is incomplete; the projected grid rectangle is a stable "
                    "placeholder and not evidence of the Tableau layout."
                ),
            ))
        native_id = zone.get("id")
        tile = _identity(
            TileIR(
                native_source_id=native_id,
                kind="query",
                title=ws.name,
                query=q,
                chart_type=chart,
                vis_config=_layout_evidence(
                    zone,
                    canvas_w=canvas_w,
                    canvas_h=canvas_h,
                    projected=rect,
                ),
                layout=rect,
            ),
            "tile",
            zone_locator,
        )
        return [tile], notes

    if zone.get("type-v2") == "text":
        text = _text_from_zone(zone)
        rect = _zone_rect(zone, canvas_w, canvas_h)
        if text is None:
            return [], [UntranslatableNote(
                object="text zone", severity="info",
                reason="Could not extract formatted text from this zone (unrecognized on-disk shape).",
            )]
        native_id = zone.get("id")
        tile = _identity(
            TileIR(
                native_source_id=native_id,
                kind="markdown",
                chart_type="markdown",
                vis_config={
                    "body": text,
                    **_layout_evidence(
                        zone,
                        canvas_w=canvas_w,
                        canvas_h=canvas_h,
                        projected=rect,
                    ),
                },
                layout=rect,
            ),
            "tile",
            zone_locator,
        )
        return [tile], []

    if children:
        tiles: list[TileIR] = []
        notes: list[UntranslatableNote] = []
        for child in children:
            t, n = _zone_to_tiles(
                child,
                worksheets,
                canvas_w,
                canvas_h,
                dashboard_locator,
            )
            tiles.extend(t)
            notes.extend(n)
        return tiles, notes

    zone_type = (zone.get("type-v2") or "").lower()
    if zone_type in {"filter", "paramctrl", "parameter", "parameter-control"}:
        return [], [UntranslatableNote(
            object=f"dashboard control {name or zone.get('id') or 'unnamed'}",
            severity="blocker",
            reason=(
                "Filter/parameter control definition was inventoried, but target field bindings, "
                "scope, defaults, and order-of-operations behavior are not automatically emitted."
            ),
        )]

    return [], [UntranslatableNote(
        object=f"zone (type-v2={zone.get('type-v2')!r}, name={name!r})",
        severity="warning",
        reason="Unrecognized zone kind is preserved as an explicit omission, not translated.",
    )]


def _dashboard_filters(dashboard: ET.Element, dashboard_locator: str) -> list[FilterIR]:
    filters: list[FilterIR] = []
    for zone in dashboard.iter("zone"):
        zone_type = (zone.get("type-v2") or "").lower()
        if zone_type not in {"filter", "paramctrl", "parameter", "parameter-control"}:
            continue
        field_reference = zone.get("field") or zone.get("param") or zone.get("name")
        locator = f"{_zone_locator(dashboard_locator, zone)}/control"
        filters.append(_identity(
            FilterIR(
                native_source_id=zone.get("id"),
                field=_field_from_reference(field_reference, {}),
                operator="source_control",
                label=zone.get("name"),
                filter_type=f"tableau_{zone_type}_control",
            ),
            "filter",
            locator,
        ))
    return filters


def _action_type(action: ET.Element) -> str:
    candidates = {
        (action.get(attribute) or "").lower()
        for attribute in ("type", "class", "command")
    }
    candidates.update(element.tag.lower() for element in action.iter())
    for action_type, tokens in (
        ("parameter", {"parameter", "param"}),
        ("set", {"set"}),
        ("filter", {"filter"}),
        ("highlight", {"highlight"}),
        ("go_to_sheet", {"go-to-sheet", "sheet"}),
        ("url", {"url"}),
    ):
        if candidates & tokens:
            return action_type
    return "unknown"


def _action_references(action: ET.Element) -> list[str]:
    references: list[str] = []
    for element in action.iter():
        for key, value in element.attrib.items():
            normalized_key = key.lower()
            if any(token in normalized_key for token in ("sheet", "dashboard", "source", "target")):
                if value not in references:
                    references.append(value)
    return references


def _dashboard_action_elements(root: ET.Element, dashboard_name: str) -> list[ET.Element]:
    actions = list(root.iter("action"))
    matched: list[ET.Element] = []
    for action in actions:
        references = _action_references(action)
        dashboard_references = [item for item in references if "dashboard" in item.lower()]
        if not dashboard_references or dashboard_name in references:
            matched.append(action)
    return matched


def tableau_dashboard_requirements(
    root: ET.Element,
    dashboard_name: str,
    *,
    artifact_key: str = "tableau-artifact",
) -> list[SemanticRequirementIR]:
    dashboard = next(
        (item for item in root.iter("dashboard") if item.get("name") == dashboard_name),
        None,
    )
    if dashboard is None:
        raise ValueError(f"No <dashboard name={dashboard_name!r}> in this workbook.")
    dashboard_locator = f"artifact:{artifact_key}/dashboard:{dashboard_name}"
    size = dashboard.find("size")
    requirements = [_identity(
        SemanticRequirementIR(
            object_type="layout",
            name=f"Tableau dashboard layout {dashboard_name}",
            support_outcome="manual",
            reason=(
                "Raw zone rectangles and hierarchy are retained, but Tableau fixed/range/automatic "
                "sizing, tiled/floating containers, device layouts, and dynamic visibility require "
                "visual reconstruction and review; no pixel parity is claimed."
            ),
            dependencies=[
                zone.get("id") or zone.get("name") or "anonymous-zone"
                for zone in dashboard.iter("zone")
            ],
            config={
                "canvas": {
                    "min_width": _int_attribute(size, "minwidth") if size is not None else None,
                    "min_height": _int_attribute(size, "minheight") if size is not None else None,
                    "max_width": _int_attribute(size, "maxwidth") if size is not None else None,
                    "max_height": _int_attribute(size, "maxheight") if size is not None else None,
                },
                "zone_count": sum(1 for _ in dashboard.iter("zone")),
                "device_layout_count": sum(
                    1
                    for element in dashboard.iter()
                    if element.tag.lower() in {"devicelayout", "device-layout"}
                ),
                "target_projection": "approximate_12_column_grid",
                "pixel_parity": False,
            },
        ),
        "semantic_requirement",
        f"{dashboard_locator}/layout-review",
    )]

    for control in _dashboard_filters(dashboard, dashboard_locator):
        requirements.append(_identity(
            SemanticRequirementIR(
                object_type="control",
                name=f"Tableau dashboard control {control.label or control.field}",
                support_outcome="decision_required",
                reason=(
                    "The control is inventoried, but its worksheet bindings, domain, defaults, and "
                    "target filter/parameter behavior require explicit review."
                ),
                dependencies=[control.field],
                config={
                    "dashboard": dashboard_name,
                    "control_type": control.filter_type,
                    "source_control_locator": control.source_locator,
                },
            ),
            "semantic_requirement",
            f"{control.source_locator}/binding-review",
        ))

    for action in _dashboard_action_elements(root, dashboard_name):
        action_name = action.get("caption") or action.get("name") or "unnamed action"
        action_locator = f"{dashboard_locator}/action:{action.get('name') or action_name}"
        requirements.append(_identity(
            SemanticRequirementIR(
                object_type="action",
                name=f"Tableau action {action_name}",
                support_outcome="unsupported",
                reason=(
                    "Tableau action behavior and ordering are not translated automatically; source "
                    "and target sheets, trigger, field mapping, and clear-selection behavior require "
                    "an explicit target interaction design."
                ),
                dependencies=_action_references(action),
                config={
                    "dashboard": dashboard_name,
                    "action_type": _action_type(action),
                    "raw_url_preserved": False,
                },
            ),
            "semantic_requirement",
            action_locator,
        ))
    return requirements


def list_tableau_dashboards(root: ET.Element) -> list[str]:
    return [d.get("name") for d in root.iter("dashboard") if d.get("name")]


def translate_tableau_dashboard(
    root: ET.Element,
    dashboard_name: str,
    *,
    source_url: str | None = None,
    artifact_key: str = "tableau-artifact",
) -> DashboardIR:
    dash_el = next((d for d in root.iter("dashboard") if d.get("name") == dashboard_name), None)
    if dash_el is None:
        raise ValueError(f"No <dashboard name={dashboard_name!r}> in this workbook.")

    size = dash_el.find("size")
    canvas_w = _int_attribute(size, "maxwidth", 1200) or 1200
    canvas_h = _int_attribute(size, "maxheight", 800) or 800
    dashboard_locator = f"artifact:{artifact_key}/dashboard:{dashboard_name}"

    worksheets = _worksheet_index(root, artifact_key=artifact_key)
    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = [UntranslatableNote(
        object=f"dashboard {dashboard_name!r} layout",
        severity="blocker",
        reason=(
            "Raw Tableau zone geometry is preserved and projected approximately to a 12-column "
            "grid. Tiled/floating, sizing, device, and visibility behavior require visual review; "
            "no pixel parity is claimed."
        ),
    )]
    zones_el = dash_el.find("zones")
    if zones_el is not None:
        for top_zone in zones_el.findall("zone"):
            t, n = _zone_to_tiles(
                top_zone,
                worksheets,
                canvas_w,
                canvas_h,
                dashboard_locator,
            )
            tiles.extend(t)
            notes.extend(n)

    filters = _dashboard_filters(dash_el, dashboard_locator)
    action_requirements = [
        requirement
        for requirement in tableau_dashboard_requirements(
            root,
            dashboard_name,
            artifact_key=artifact_key,
        )
        if requirement.object_type == "action"
    ]
    notes.extend(UntranslatableNote(
        object=requirement.name,
        severity="blocker",
        reason=requirement.reason,
    ) for requirement in action_requirements)

    dashboard = _identity(
        DashboardIR(
            native_source_id=dashboard_name,
            selection_aliases=[dashboard_name],
            name=dashboard_name,
            tiles=tiles,
            filters=filters,
            filter_order=[item.source_id for item in filters if item.source_id],
            tile_order=[item.source_id for item in tiles if item.source_id],
            source_url=source_url,
            untranslatable=notes,
        ),
        "dashboard",
        dashboard_locator,
    )
    return dashboard

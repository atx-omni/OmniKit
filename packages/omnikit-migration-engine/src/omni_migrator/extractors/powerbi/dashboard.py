"""Power BI report `Report/Layout` (the `.pbix`'s zip-embedded JSON) -> `DashboardIR`.

**Caveat, stated up front:** unlike Looker's documented dashboard API, the Layout JSON is an
*internal, undocumented* Power BI Desktop format (reverse-engineered by the community via
tools like `pbi-tools`; it has shifted across versions and the newer PBIR project format
differs from the legacy single-file shape this targets). Treat every field below as
best-effort, and bias hard toward flagging `untranslatable` over guessing — this seed feeds
straight into the AI dashboard sub-agent (plan §12.2 discipline), so an honest "I'm not sure"
hint beats a confidently-wrong field reference.

One Power BI report can have multiple pages (`sections`); each becomes its own `DashboardIR`
(Omni's dashboard is a single-screen concept, same granularity as a Looker dashboard).
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

from omni_migrator.deterministic.dashboard_maps import grid_from_pixels, powerbi_chart_type
from omni_migrator.ir.schema import DashboardIR, FilterIR, QueryIR, TileIR, UntranslatableNote, ViewIR

_TITLE_LITERAL = re.compile(r"^'(.*)'$")


def load_layout(path: Path) -> dict:
    """Read and parse `Report/Layout` from a `.pbix` (an OPC zip). UTF-16 (with BOM)."""
    with zipfile.ZipFile(path) as zf:
        raw = zf.read("Report/Layout")
    return json.loads(raw.decode("utf-16"))


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", text.strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _parse_config(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}


def _title_text(config: dict) -> str | None:
    for obj in (config.get("singleVisual", {}).get("objects", {}) or {}).get("title", []):
        value = (
            obj.get("properties", {}).get("text", {}).get("expr", {}).get("Literal", {}).get("Value")
        )
        if value:
            m = _TITLE_LITERAL.match(value)
            return m.group(1) if m else value
    return None


def _textbox_text(config: dict) -> str:
    """Best-effort: textbox rich text lives as a list of `textRuns` with `.value`."""
    general = (config.get("singleVisual", {}).get("objects", {}) or {}).get("general", [])
    parts: list[str] = []
    for obj in general:
        paragraphs = obj.get("properties", {}).get("paragraphs", [])
        for p in paragraphs:
            for run in p.get("textRuns", []):
                if run.get("value"):
                    parts.append(run["value"])
    return " ".join(parts)


def _entity_alias(query: dict) -> dict[str, str]:
    """`Source` alias -> table `Entity` name, from the query's `From` clause."""
    return {f.get("Name"): f.get("Entity") for f in query.get("From", []) if f.get("Name")}


def _select_to_field(select: dict, aliases: dict[str, str]) -> tuple[str | None, str | None, str | None]:
    """One `Select` entry -> `(field_name, untranslatable_hint, implicit_agg_table)`. For a
    resolved field or an unrecognized shape, only the first two vary; `implicit_agg_table` is
    set only for the `Aggregation` case, so a caller with a `views` dict can route that hint
    onto the underlying `ViewIR` too, not just the tile."""
    if "Column" in select:
        col = select["Column"]
        return _snake(col.get("Property", "")), None, None
    if "Measure" in select:
        meas = select["Measure"]
        return _snake(meas.get("Property", "")), None, None
    if "Aggregation" in select:
        agg = select["Aggregation"]
        inner = (agg.get("Expression") or {}).get("Column", {})
        source = (inner.get("Expression") or {}).get("SourceRef", {}).get("Source")
        table = aliases.get(source, source)
        column = inner.get("Property")
        func = agg.get("Function")
        return None, (
            f"implicit aggregate (function code {func}) over {table}.{column}; "
            "no explicit Omni measure to reference deterministically — pick/create one."
        ), table
    return None, f"Unrecognized Select shape: {sorted(select)}", None


def _query_to_ir(query: dict, *, object_label: str) -> tuple[QueryIR | None, list[UntranslatableNote]]:
    aliases = _entity_alias(query)
    topic = next(iter(aliases.values()), None)
    if not topic:
        return None, [UntranslatableNote(
            object=object_label, severity="warning",
            reason="prototypeQuery has no `From` entity; cannot determine the topic.",
        )]
    fields: list[str] = []
    notes: list[UntranslatableNote] = []
    for select in query.get("Select", []):
        field, hint, _agg_table = _select_to_field(select, aliases)
        if field:
            fields.append(field)
        else:
            notes.append(UntranslatableNote(
                object=f"{object_label} field {select.get('Name', '?')}",
                severity="info", hint=hint, reason=hint or "Could not resolve this field.",
            ))
    return QueryIR(topic=_snake(topic), fields=fields), notes


def attach_visual_aggregate_hints(layout: dict, views: dict[str, ViewIR]) -> None:
    """Scan every visual's `prototypeQuery` for an implicit aggregate (Power BI's "drag a raw
    column onto a visual, pick Sum" pattern) and attach its hint to the underlying `ViewIR`.

    Meant to be called at *model*-extraction time (`extractors/powerbi/extractor.py`), not just
    dashboard-migration time — an implicit aggregate is real, actively-used business logic the
    deterministic model pass has no way to detect on its own, and until this exists, that logic
    was visible only to the dashboard-migration AI job's seed prompt (as a per-tile hint), never
    to the modeling AI job — so a measure it implies had no path onto the model even if a chart
    built entirely from it was already live on a report page. Mirrors the Metabase fix for
    ad-hoc dashboard SQL (`extractors/metabase/extractor.py`'s `_build_card_hints`)."""
    for section in layout.get("sections", []):
        for vc in section.get("visualContainers", []):
            config = _parse_config(vc.get("config"))
            query = (config.get("singleVisual") or {}).get("prototypeQuery")
            if not query:
                continue
            aliases = _entity_alias(query)
            for select in query.get("Select", []):
                _, hint, agg_table = _select_to_field(select, aliases)
                if not agg_table:
                    continue
                view = views.get(_snake(agg_table))
                if view is None:
                    continue
                view.untranslatable.append(UntranslatableNote(
                    object=f"dashboard visual over {agg_table}", severity="info", hint=hint,
                    reason="Implicit visual aggregate referencing this table (not an explicit "
                    "Omni measure) — may be reusable business logic worth adding as a real measure.",
                ))


def _visual_to_tile(vc: dict, page_w: int, page_h: int):
    """One `visualContainers` entry -> `(TileIR | None, [UntranslatableNote])`."""
    rect = grid_from_pixels(
        vc.get("x", 0), vc.get("y", 0), vc.get("width", 0), vc.get("height", 0), page_w, page_h,
    )
    config = _parse_config(vc.get("config"))
    single = config.get("singleVisual")
    label = f"tile «{config.get('name') or _title_text(config) or '?'}»"

    if single is None:
        return None, [UntranslatableNote(
            object=label, severity="warning", hint=str(sorted(config)) if config else None,
            reason="Not a `singleVisual` container (e.g. a visual group or combo visual); needs AI/manual rebuild.",
        )]

    vis_type = single.get("visualType")
    title = _title_text(config)

    if vis_type == "textbox":
        return TileIR(
            kind="markdown", title=title, chart_type="markdown",
            vis_config={"body": _textbox_text(config)}, layout=rect,
        ), []

    if vis_type in ("image", "shape", "shapeMap"):
        return None, [UntranslatableNote(
            object=label, severity="info", hint=vis_type,
            reason=f"Decorative '{vis_type}' visual is not a data tile; not migrated.",
        )]

    query = single.get("prototypeQuery")
    if not query:
        return None, [UntranslatableNote(
            object=label, severity="warning", hint=vis_type,
            reason=f"Visual type '{vis_type}' has no `prototypeQuery`; cannot translate.",
        )]

    q_ir, q_notes = _query_to_ir(query, object_label=label)
    if q_ir is None or not q_ir.fields:
        q_notes.append(UntranslatableNote(
            object=label, severity="warning",
            reason="No field on this tile resolved deterministically; not emitted (see field notes above).",
        ))
        return None, q_notes

    chart = powerbi_chart_type(vis_type)
    if vis_type and chart is None:
        q_notes.append(UntranslatableNote(
            object=label, severity="info", hint=vis_type,
            reason=f"Unmapped Power BI visual '{vis_type}'; defaulted to table.",
        ))
        chart = "table"
    return TileIR(kind="query", title=title, query=q_ir, chart_type=chart, layout=rect), q_notes


def _slicer_to_filter(vc: dict) -> tuple[FilterIR | None, UntranslatableNote | None]:
    config = _parse_config(vc.get("config"))
    query = (config.get("singleVisual") or {}).get("prototypeQuery")
    if not query:
        return None, UntranslatableNote(
            object="slicer", severity="info",
            reason="Slicer has no prototypeQuery; cannot determine its bound field.",
        )
    aliases = _entity_alias(query)
    selects = query.get("Select", [])
    if not selects:
        return None, UntranslatableNote(object="slicer", severity="info", reason="Slicer binds no field.")
    field, hint, _agg_table = _select_to_field(selects[0], aliases)
    if not field:
        return None, UntranslatableNote(object="slicer", severity="info", hint=hint, reason=hint or "Unresolved.")
    return FilterIR(field=field, operator="default", values=[]), None


def translate_powerbi_layout(layout: dict, *, source_url: str | None = None) -> list[DashboardIR]:
    dashboards: list[DashboardIR] = []
    for section in layout.get("sections", []):
        page_w, page_h = section.get("width", 1280), section.get("height", 720)
        tiles: list[TileIR] = []
        filters: list[FilterIR] = []
        notes: list[UntranslatableNote] = []
        for vc in section.get("visualContainers", []):
            config = _parse_config(vc.get("config"))
            vis_type = (config.get("singleVisual") or {}).get("visualType")
            if vis_type == "slicer":
                f, note = _slicer_to_filter(vc)
                if f:
                    filters.append(f)
                if note:
                    notes.append(note)
                continue
            tile, tile_notes = _visual_to_tile(vc, page_w, page_h)
            if tile:
                tiles.append(tile)
            notes.extend(tile_notes)
        dashboards.append(DashboardIR(
            name=section.get("displayName") or section.get("name") or "page",
            tiles=tiles, filters=filters, source_url=source_url, untranslatable=notes,
        ))
    return dashboards

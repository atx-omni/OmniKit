"""Tableau `<worksheet>` (shelves + mark) + `<dashboard>` (zone tree) -> `DashboardIR`.

**Caveat, stated up front (same discipline as `powerbi/dashboard.py`):** built from the
documented, stable `.twb` XML vocabulary (worksheet `<rows>`/`<cols>` shelf syntax, mark
classes, the dashboard zone tree) — there was no live Tableau instance to verify field-level
details against while writing this, unlike Looker/Power BI's dashboard translators. Bias hard
toward flagging `untranslatable` over guessing (plan §12.2 discipline): dashboard actions,
quick-filter/parameter zones, and dual-axis/combo marks are all flagged rather than
half-translated from an unverified schema, so `DashboardIR.filters` is always empty here — no
filter zone is confidently parsed.

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

from omni_migrator.deterministic.dashboard_maps import grid_from_tableau_zone, tableau_chart_type
from omni_migrator.extractors.tableau.extractor import _load_root
from omni_migrator.ir.schema import DashboardIR, QueryIR, TileIR, UntranslatableNote

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
    def __init__(self, name: str, mark: str | None, rows: str, cols: str,
                 field_captions: dict[str, str], topic: str | None):
        self.name = name
        self.mark = mark
        self.rows = rows
        self.cols = cols
        self.field_captions = field_captions
        self.topic = topic


def _worksheet_topic(view: ET.Element | None) -> str | None:
    ds = view.find("datasources/datasource") if view is not None else None
    if ds is None:
        return None
    return _snake(ds.get("caption") or ds.get("name") or "")


def _worksheet_index(root: ET.Element) -> dict[str, _Worksheet]:
    out: dict[str, _Worksheet] = {}
    for ws in root.iter("worksheet"):
        name = ws.get("name")
        table = ws.find("table")
        if not name or table is None:
            continue
        view = table.find("view")
        field_captions: dict[str, str] = {}
        if view is not None:
            for dep in view.findall("datasource-dependencies"):
                for col in dep.findall("column"):
                    cname = _strip_brackets(col.get("name"))
                    if cname:
                        field_captions[cname] = col.get("caption") or cname
        mark = None
        panes = table.find("panes")
        if panes is not None:
            mark_el = panes.find(".//mark")
            if mark_el is not None:
                mark = mark_el.get("class")
        out[name] = _Worksheet(
            name=name, mark=mark,
            rows=table.findtext("rows") or "", cols=table.findtext("cols") or "",
            field_captions=field_captions, topic=_worksheet_topic(view),
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
    ]

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

    return QueryIR(topic=ws.topic, fields=fields), notes, col_has_measure


def _text_from_zone(zone: ET.Element) -> str | None:
    """Best-effort formatted-text extraction. Tableau has used more than one on-disk shape for
    zone text across versions; this checks the two documented ones and returns `None` (never
    guesses at content) if neither matches."""
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


def _zone_rect(zone: ET.Element, canvas_w: int, canvas_h: int):
    return grid_from_tableau_zone(
        int(zone.get("x") or 0), int(zone.get("y") or 0),
        int(zone.get("w") or 0), int(zone.get("h") or 0),
        canvas_w, canvas_h,
    )


def _zone_to_tiles(
    zone: ET.Element, worksheets: dict[str, _Worksheet], canvas_w: int, canvas_h: int,
) -> tuple[list[TileIR], list[UntranslatableNote]]:
    name = zone.get("name")
    children = zone.findall("zone")

    if name and name in worksheets:
        ws = worksheets[name]
        q, notes, measure_on_cols = _worksheet_query(ws)
        if q is None:
            return [], notes
        chart = tableau_chart_type(ws.mark, measure_on_cols=measure_on_cols)
        if ws.mark and chart is None:
            notes.append(UntranslatableNote(
                object=f"worksheet {ws.name!r}", severity="info", hint=ws.mark,
                reason=f"Unmapped Tableau mark {ws.mark!r}; defaulted to table.",
            ))
            chart = "table"
        rect = _zone_rect(zone, canvas_w, canvas_h)
        return [TileIR(kind="query", title=ws.name, query=q, chart_type=chart or "table", layout=rect)], notes

    if zone.get("type-v2") == "text":
        text = _text_from_zone(zone)
        rect = _zone_rect(zone, canvas_w, canvas_h)
        if text is None:
            return [], [UntranslatableNote(
                object="text zone", severity="info",
                reason="Could not extract formatted text from this zone (unrecognized on-disk shape).",
            )]
        return [TileIR(kind="markdown", chart_type="markdown", vis_config={"body": text}, layout=rect)], []

    if children:
        tiles: list[TileIR] = []
        notes: list[UntranslatableNote] = []
        for child in children:
            t, n = _zone_to_tiles(child, worksheets, canvas_w, canvas_h)
            tiles.extend(t)
            notes.extend(n)
        return tiles, notes

    # A leaf zone that's neither a known worksheet nor recognized text — title, filter,
    # parameter, image, or web zone. Not translated: the exact XML shape for these isn't
    # verified here, and guessing at filter/parameter semantics risks a confidently-wrong tile.
    return [], [UntranslatableNote(
        object=f"zone (type-v2={zone.get('type-v2')!r}, name={name!r})", severity="info",
        reason="Unrecognized zone kind (likely a title, filter, parameter, image, or web zone) — "
               "not translated.",
    )]


def list_tableau_dashboards(root: ET.Element) -> list[str]:
    return [d.get("name") for d in root.iter("dashboard") if d.get("name")]


def translate_tableau_dashboard(
    root: ET.Element, dashboard_name: str, *, source_url: str | None = None,
) -> DashboardIR:
    dash_el = next((d for d in root.iter("dashboard") if d.get("name") == dashboard_name), None)
    if dash_el is None:
        raise ValueError(f"No <dashboard name={dashboard_name!r}> in this workbook.")

    size = dash_el.find("size")
    canvas_w = int(size.get("maxwidth")) if size is not None and size.get("maxwidth") else 1200
    canvas_h = int(size.get("maxheight")) if size is not None and size.get("maxheight") else 800

    worksheets = _worksheet_index(root)
    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = []
    zones_el = dash_el.find("zones")
    if zones_el is not None:
        for top_zone in zones_el.findall("zone"):
            t, n = _zone_to_tiles(top_zone, worksheets, canvas_w, canvas_h)
            tiles.extend(t)
            notes.extend(n)

    return DashboardIR(
        name=dashboard_name, tiles=tiles, filters=[], source_url=source_url, untranslatable=notes,
    )

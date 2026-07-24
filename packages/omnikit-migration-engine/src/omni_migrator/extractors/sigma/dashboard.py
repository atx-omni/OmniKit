"""Sigma workbook `pages[].elements[]` -> `DashboardIR`, one per page.

A Sigma workbook is organized into pages (like tabs) — the closest analog among sources built so
far is Power BI's report pages (`powerbi/dashboard.py`, one `DashboardIR` per page), not Looker's
single whole-dashboard object, since a page is what a user would actually pick to migrate as "one
dashboard" (mirrors the `sigma-workbook-pages` / `migrate-sigma-dashboard --page` CLI pattern).

**The real, load-bearing gap: no layout API.** `GET .../pages/{id}/elements` returns
`elementId, name, type, columns[], vizualizationType` (that spelling is the API's own documented
typo, not ours to fix) `, error` — no x/y/width/height anywhere (plan §6.4). Every tile gets
`deterministic.dashboard_maps.grid_naive_stack`'s top-to-bottom full-width placement instead of a
real grid mapping, and the AI dashboard sub-agent is relied on for actual layout entirely — same
posture as the plan's explicit recommendation for this source.

**Element -> topic resolution is itself a bridge, not a documented field.** Nothing in the
workbook pages/elements response says which data-model view an element's `columns[]` belong to
(unlike Metabase's dashcard -> card -> `dataset_query.source-table`) — resolved here by looking
each column id up in the data-model `column_ref` map the model extractor already built
(`extractor.py`'s `_build_views`), and using whichever view the *first* resolved column belongs to
as the tile's topic; a column resolving to a different view is flagged, not silently dropped or
guessed into a fabricated join.

**Controls/filters are not translated in v1.** Sigma's control-element shape (which `type`/
`vizualizationType` values denote a List/Text/Date/etc. control rather than a data tile) isn't in
the docs excerpt this was built against — rather than guess a shape with zero confirmation,
control-like elements are left as an `untranslatable` note. Revisit once a live workbook shows the
real element `type` enum.

**Not verified against a live Sigma instance** — see the module-level caveat in `extractor.py`;
treat with the same skepticism as Tableau's dashboard translator until spot-checked live.
"""

from __future__ import annotations

from omni_migrator.deterministic.dashboard_maps import grid_naive_stack, sigma_chart_type
from omni_migrator.ir.schema import DashboardIR, QueryIR, TileIR, UntranslatableNote


def _element_to_tile(
    element: dict, column_ref: dict[str, tuple[str, str]], index: int,
) -> tuple[TileIR | None, list[UntranslatableNote]]:
    label = f"element «{element.get('name') or element.get('elementId')}»"
    if element.get("error"):
        return None, [UntranslatableNote(
            object=label, severity="warning",
            reason=f"Element has a query error in Sigma: {element['error']}",
        )]

    notes: list[UntranslatableNote] = []
    topic: str | None = None
    fields: list[str] = []
    for col in element.get("columns", []):
        col_id = col.get("columnId") if isinstance(col, dict) else col
        ref = column_ref.get(col_id)
        if ref is None:
            notes.append(UntranslatableNote(
                object=f"{label} column", severity="info", hint=str(col),
                reason="Unresolved column reference — not found in any extracted data model.",
            ))
            continue
        view_name, field_name = ref
        if topic is None:
            topic = view_name
        elif view_name != topic:
            notes.append(UntranslatableNote(
                object=f"{label} column {field_name}", severity="info",
                reason=f"References a different table ({view_name}) than this element's topic "
                f"({topic}) — cross-table tile fields need AI translation.",
            ))
            continue
        fields.append(field_name)

    if topic is None or not fields:
        notes.append(UntranslatableNote(
            object=label, severity="warning",
            reason="No column on this element resolved to a known data-model field; not emitted "
            "(possibly a control element — control/filter translation isn't implemented yet, see "
            "module docstring).",
        ))
        return None, notes

    viz_type = element.get("vizualizationType") or element.get("type")
    chart = sigma_chart_type(viz_type)
    if viz_type and chart is None:
        notes.append(UntranslatableNote(
            object=label, severity="info", hint=viz_type,
            reason=f"Unmapped Sigma visualization type {viz_type!r}; defaulted to table.",
        ))
        chart = "table"

    raw_element_id = element.get("elementId") or element.get("id")
    native_id = str(raw_element_id) if raw_element_id is not None else None
    return TileIR(
        native_source_id=native_id,
        source_locator=f"element:{native_id}" if native_id else None,
        kind="query", title=element.get("name") or label, query=QueryIR(topic=topic, fields=fields),
        chart_type=chart or "table", layout=grid_naive_stack(index),
    ), notes


def translate_sigma_page(
    page: dict, *, column_ref: dict[str, tuple[str, str]] | None = None, source_url: str | None = None,
    workbook_id: str | None = None,
) -> DashboardIR:
    column_ref = column_ref or {}
    tiles: list[TileIR] = []
    notes: list[UntranslatableNote] = []
    for i, element in enumerate(page.get("elements", [])):
        tile, tile_notes = _element_to_tile(element, column_ref, i)
        if tile:
            tiles.append(tile)
        notes.extend(tile_notes)

    raw_page_id = page.get("pageId") or page.get("id")
    page_id = str(raw_page_id) if raw_page_id is not None else None
    aliases = [item for item in [workbook_id, page_id] if item]
    return DashboardIR(
        native_source_id=page_id,
        selection_aliases=list(dict.fromkeys(aliases)),
        source_locator=f"workbook:{workbook_id}/page:{page_id or page.get('name')}" if workbook_id else None,
        name=page.get("name") or "page", tiles=tiles, filters=[],
        source_url=source_url, untranslatable=notes,
    )

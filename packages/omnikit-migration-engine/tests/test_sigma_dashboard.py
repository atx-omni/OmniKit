"""Sigma workbook page `elements[]` -> `DashboardIR`. No live instance to verify the actual
`vizualizationType`/element wire shapes against (plan §6.4) — these lock in the documented
`elementId, name, type, columns[], vizualizationType, error` shape and the naive-stack layout
fallback (there is no layout API at all to map from, unlike every other source built so far)."""

from __future__ import annotations

from omni_migrator.extractors.sigma.dashboard import translate_sigma_page
from omni_migrator.ir.schema import GridRect


def _column_ref():
    return {
        "col-price": ("order_items", "sale_price"),
        "col-status": ("order_items", "status"),
        "col-brand": ("inventory_items", "brand"),
    }


def test_element_becomes_query_tile_with_resolved_fields():
    page = {
        "name": "Overview",
        "elements": [
            {"elementId": "e1", "name": "Revenue Trend", "vizualizationType": "Line", "columns": [{"columnId": "col-price"}]},
        ],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    (tile,) = dash.tiles
    assert tile.title == "Revenue Trend"
    assert tile.chart_type == "line"
    assert tile.query.topic == "order_items"
    assert tile.query.fields == ["sale_price"]
    assert tile.native_source_id == "e1"
    assert tile.source_locator == "element:e1"


def test_documented_page_and_element_ids_are_preserved_for_provenance():
    page = {
        "pageId": "page-1",
        "name": "Overview",
        "elements": [
            {
                "elementId": "element-1",
                "name": "Revenue",
                "vizualizationType": "Bar",
                "columns": [{"columnId": "col-price"}],
            },
        ],
    }

    dash = translate_sigma_page(page, column_ref=_column_ref(), workbook_id="workbook-1")

    assert dash.native_source_id == "page-1"
    assert dash.selection_aliases == ["workbook-1", "page-1"]
    assert dash.source_locator == "workbook:workbook-1/page:page-1"
    assert dash.tiles[0].native_source_id == "element-1"
    assert dash.tiles[0].source_locator == "element:element-1"


def test_tiles_stack_top_to_bottom_full_width():
    """No layout API exists at all (plan §6.4) — every tile is a naive full-width stack, not a
    guessed grid mapping."""
    page = {
        "name": "Overview",
        "elements": [
            {"elementId": "e1", "name": "A", "vizualizationType": "Bar", "columns": [{"columnId": "col-price"}]},
            {"elementId": "e2", "name": "B", "vizualizationType": "Bar", "columns": [{"columnId": "col-status"}]},
        ],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    assert dash.tiles[0].layout == GridRect(x=0, y=0, w=12, h=6)
    assert dash.tiles[1].layout == GridRect(x=0, y=6, w=12, h=6)


def test_pie_donut_combined_type_maps_to_pie():
    """Sigma's docs list this chart type combined as "Pie/Donut" — confirm the `/` doesn't break
    the normalized lookup key."""
    page = {
        "name": "P", "elements": [
            {"elementId": "e1", "name": "Status Split", "vizualizationType": "Pie/Donut", "columns": [{"columnId": "col-status"}]},
        ],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    (tile,) = dash.tiles
    assert tile.chart_type == "pie"
    assert not dash.untranslatable


def test_unmapped_visualization_type_defaults_to_table_with_note():
    page = {
        "name": "P", "elements": [
            {"elementId": "e1", "name": "Weird", "vizualizationType": "Sunburst", "columns": [{"columnId": "col-status"}]},
        ],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    (tile,) = dash.tiles
    assert tile.chart_type == "table"
    assert any("Sunburst" in n.hint for n in dash.untranslatable)


def test_element_with_query_error_is_skipped_not_emitted():
    page = {
        "name": "P", "elements": [{"elementId": "e1", "name": "Broken", "error": "query timeout", "columns": []}],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    assert dash.tiles == []
    assert any("query timeout" in n.reason for n in dash.untranslatable)


def test_unresolved_column_reference_is_noted_not_guessed():
    page = {
        "name": "P", "elements": [
            {"elementId": "e1", "name": "Ghost", "vizualizationType": "Bar", "columns": [{"columnId": "col-unknown"}]},
        ],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    assert dash.tiles == []
    assert any("Unresolved column reference" in n.reason for n in dash.untranslatable)


def test_cross_table_columns_on_one_element_flagged_not_joined():
    """An element referencing columns from two different data-model views isn't guessed into a
    fabricated join — the first-resolved view wins as the topic, the rest are flagged."""
    page = {
        "name": "P", "elements": [
            {
                "elementId": "e1", "name": "Mixed", "vizualizationType": "Table",
                "columns": [{"columnId": "col-price"}, {"columnId": "col-brand"}],
            },
        ],
    }
    dash = translate_sigma_page(page, column_ref=_column_ref())
    (tile,) = dash.tiles
    assert tile.query.topic == "order_items"
    assert tile.query.fields == ["sale_price"]
    assert any("different table" in n.reason for n in dash.untranslatable)

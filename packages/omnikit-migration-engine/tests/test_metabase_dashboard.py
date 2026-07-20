"""Metabase `dashboard` + `dashcard` JSON -> DashboardIR."""

from __future__ import annotations

from omni_migrator.deterministic.mbql_translate import FieldMeta
from omni_migrator.extractors.metabase.dashboard import translate_metabase_dashboard

ORDERS = 100
FIELD_INDEX = {
    10: FieldMeta(view="orders", name="id", table_id=ORDERS),
    11: FieldMeta(view="orders", name="amount", table_id=ORDERS),
    12: FieldMeta(view="orders", name="status", table_id=ORDERS),
}
TABLE_VIEW = {ORDERS: "orders"}


def _mbql_question_card(card_id=1, name="Revenue by status"):
    return {
        "id": card_id, "type": "question", "name": name, "display": "bar",
        "dataset_query": {
            "type": "query",
            "query": {
                "source-table": ORDERS,
                "aggregation": [["metric", 5]],
                "breakout": [["field", 12, None]],
                "filter": ["=", ["field", 12, None], "completed"],
            },
        },
    }


def _native_question_card(card_id=2):
    return {
        "id": card_id, "type": "question", "name": "Raw SQL", "display": "table",
        "dataset_query": {
            "type": "native",
            "native": {"query": "select * from orders where status = {{status}}", "template-tags": {"status": {}}},
        },
    }


def test_mbql_question_tile_with_known_metric_and_filter():
    dash = {
        "id": 1, "name": "Ops",
        "dashcards": [
            {"id": 1, "card_id": 1, "card": _mbql_question_card(), "row": 0, "col": 0, "size_x": 9, "size_y": 4},
        ],
        "parameters": [],
    }
    dashboard = translate_metabase_dashboard(
        dash, field_index=FIELD_INDEX, table_view=TABLE_VIEW, metric_field_names={5: "total_revenue"},
    )
    (tile,) = dashboard.tiles
    assert tile.kind == "query" and tile.chart_type == "column"  # bar -> column, plan §A.10 mapping
    assert tile.query.topic == "orders"
    assert tile.query.fields == ["total_revenue", "status"]
    (filt,) = tile.query.filters
    assert (filt.field, filt.operator, filt.values, filt.is_negative) == ("status", "equals", ["completed"], False)
    assert tile.layout.w == 6  # 9/18*12


def test_ad_hoc_aggregation_without_metric_is_untranslatable():
    card = _mbql_question_card(card_id=3)
    card["dataset_query"]["query"]["aggregation"] = [["sum", ["field", 11, None]]]  # no backing metric
    dash = {"id": 2, "name": "Ops", "dashcards": [{"id": 2, "card_id": 3, "card": card, "row": 0, "col": 0, "size_x": 4, "size_y": 4}]}
    dashboard = translate_metabase_dashboard(dash, field_index=FIELD_INDEX, table_view=TABLE_VIEW)
    # breakout on status still resolves, so a tile IS emitted, but with an untranslatable aggregation note
    assert dashboard.tiles and dashboard.tiles[0].query.fields == ["status"]
    assert any("no backing Omni measure field" in n.reason for n in dashboard.untranslatable)


def test_native_sql_card_is_untranslatable_tile():
    dash = {
        "id": 3, "name": "Ops",
        "dashcards": [{"id": 3, "card_id": 2, "card": _native_question_card(), "row": 0, "col": 0, "size_x": 4, "size_y": 4}],
    }
    dashboard = translate_metabase_dashboard(dash, field_index=FIELD_INDEX, table_view=TABLE_VIEW)
    assert dashboard.tiles == []
    assert any("Native-SQL question" in n.reason for n in dashboard.untranslatable)


def test_virtual_text_dashcard_becomes_markdown_tile():
    dash = {
        "id": 4, "name": "Ops",
        "dashcards": [{
            "id": 4, "card_id": None, "row": 0, "col": 0, "size_x": 18, "size_y": 2,
            "visualization_settings": {"virtual_card": {"display": "text"}, "text": "## Section header"},
        }],
    }
    dashboard = translate_metabase_dashboard(dash, field_index=FIELD_INDEX, table_view=TABLE_VIEW)
    (tile,) = dashboard.tiles
    assert tile.kind == "markdown" and tile.vis_config["body"] == "## Section header"
    assert tile.layout.w == 12  # full 18-col width -> full 12-col Omni width


def test_unmapped_display_defaults_to_table_with_info_note():
    card = _mbql_question_card(card_id=4, name="Weird viz")
    card["display"] = "some-future-display"
    dash = {"id": 5, "name": "Ops", "dashcards": [{"id": 5, "card_id": 4, "card": card, "row": 0, "col": 0, "size_x": 4, "size_y": 4}]}
    dashboard = translate_metabase_dashboard(dash, field_index=FIELD_INDEX, table_view=TABLE_VIEW, metric_field_names={5: "total_revenue"})
    (tile,) = dashboard.tiles
    assert tile.chart_type == "table"
    assert any("Unmapped Metabase display" in n.reason for n in dashboard.untranslatable)


def test_dashboard_parameter_resolves_bound_field():
    dash = {
        "id": 6, "name": "Ops",
        "parameters": [{"id": "p1", "name": "Status", "slug": "status", "default": "completed"}],
        "dashcards": [{
            "id": 6, "card_id": 1, "card": _mbql_question_card(),
            "row": 0, "col": 0, "size_x": 4, "size_y": 4,
            "parameter_mappings": [{"parameter_id": "p1", "card_id": 1, "target": ["dimension", ["field", 12, None]]}],
        }],
    }
    dashboard = translate_metabase_dashboard(dash, field_index=FIELD_INDEX, table_view=TABLE_VIEW, metric_field_names={5: "total_revenue"})
    (filt,) = dashboard.filters
    assert filt.field == "status" and filt.operator == "default" and filt.values == ["completed"]

"""Tableau `<worksheet>`/`<dashboard>` -> DashboardIR (fixture: orders_dashboard.twb)."""

from __future__ import annotations

from pathlib import Path

import pytest

from omni_migrator.extractors.tableau.dashboard import (
    list_tableau_dashboards,
    load_workbook_root,
    translate_tableau_dashboard,
)

FIXTURE = Path(__file__).parent / "fixtures" / "orders_dashboard.twb"


def _root():
    return load_workbook_root(FIXTURE)


def test_list_dashboards():
    assert list_tableau_dashboards(_root()) == ["Overview"]


def test_worksheet_tiles_have_queries_and_chart_types():
    dash = translate_tableau_dashboard(_root(), "Overview", source_url="file://orders_dashboard.twb")
    assert dash.name == "Overview"
    assert dash.source_url == "file://orders_dashboard.twb"

    by_title = {t.title: t for t in dash.tiles if t.kind == "query"}
    assert set(by_title) == {"Sales by Region", "Orders Over Time"}

    bars = by_title["Sales by Region"]
    assert bars.query.topic == "orders"
    assert set(bars.query.fields) == {"region", "amount"}
    # measure (Amount) is on cols -> vertical bar, i.e. Omni's "column"
    assert bars.chart_type == "column"

    line = by_title["Orders Over Time"]
    assert set(line.query.fields) == {"created_at", "amount"}
    assert line.chart_type == "line"


def test_text_zone_becomes_markdown_tile():
    dash = translate_tableau_dashboard(_root(), "Overview")
    markdown_tiles = [t for t in dash.tiles if t.kind == "markdown"]
    assert len(markdown_tiles) == 1
    assert markdown_tiles[0].vis_config["body"] == "Dashboard notes"


def test_filter_control_is_inventoried_without_claiming_filter_behavior():
    dash = translate_tableau_dashboard(_root(), "Overview")
    reasons = " ".join(n.reason for n in dash.untranslatable)
    assert "Filter/parameter control definition was inventoried" in reasons
    assert len(dash.filters) == 1
    assert dash.filters[0].operator == "source_control"


def test_unknown_mark_preserves_query_but_never_defaults_to_table():
    root = _root()
    worksheet = next(
        item for item in root.iter("worksheet") if item.get("name") == "Sales by Region"
    )
    worksheet.find(".//mark").set("class", "UnmappedMark")

    dash = translate_tableau_dashboard(root, "Overview")
    tile = next(item for item in dash.tiles if item.title == "Sales by Region")

    assert tile.kind == "query"
    assert tile.query is not None
    assert tile.query.fields
    assert tile.chart_type is None
    assert tile.chart_type != "table"
    note = next(
        item for item in dash.untranslatable if "Unmapped Tableau mark" in item.reason
    )
    assert note.severity == "blocker"
    assert note.hint == "UnmappedMark"
    assert "intentionally unset" in note.reason


def test_layout_stacks_tiles_left_to_right():
    dash = translate_tableau_dashboard(_root(), "Overview")
    by_title = {t.title: t for t in dash.tiles if t.kind == "query"}
    assert by_title["Sales by Region"].layout.x < by_title["Orders Over Time"].layout.x


def test_unknown_dashboard_name_raises():
    with pytest.raises(ValueError, match="No <dashboard"):
        translate_tableau_dashboard(_root(), "Does Not Exist")

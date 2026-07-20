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


def test_unrecognized_zone_is_untranslatable_not_guessed():
    dash = translate_tableau_dashboard(_root(), "Overview")
    reasons = " ".join(n.reason for n in dash.untranslatable)
    assert "Unrecognized zone kind" in reasons
    assert dash.filters == []  # no filter zone is ever confidently parsed (see module docstring)


def test_layout_stacks_tiles_left_to_right():
    dash = translate_tableau_dashboard(_root(), "Overview")
    by_title = {t.title: t for t in dash.tiles if t.kind == "query"}
    assert by_title["Sales by Region"].layout.x < by_title["Orders Over Time"].layout.x


def test_unknown_dashboard_name_raises():
    with pytest.raises(ValueError, match="No <dashboard"):
        translate_tableau_dashboard(_root(), "Does Not Exist")

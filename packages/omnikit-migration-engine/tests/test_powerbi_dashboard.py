"""Power BI Report/Layout JSON -> DashboardIR.

Built inline (not a fixture file) because `visualContainers[].config` is itself a
JSON *string* — easier to construct with `json.dumps` than hand-author nested JSON.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from omni_migrator.extractors.powerbi.dashboard import attach_visual_aggregate_hints, load_layout, translate_powerbi_layout
from omni_migrator.ir.schema import ViewIR


def _visual(name, x, y, w, h, single_visual=None, *, raw_config=None):
    return {
        "x": x, "y": y, "z": 0, "width": w, "height": h,
        "config": raw_config if raw_config is not None else json.dumps({"name": name, "singleVisual": single_visual}),
    }


def _title(text):
    return {"title": [{"properties": {"text": {"expr": {"Literal": {"Value": f"'{text}'"}}}}}]}


def _layout():
    column_chart = _visual(
        "v1", 0, 0, 640, 320,
        {
            "visualType": "columnChart",
            "objects": _title("Revenue by Month"),
            "prototypeQuery": {
                "From": [{"Name": "o", "Entity": "Orders"}],
                "Select": [
                    {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OrderDate"},
                     "Name": "Orders.OrderDate"},
                    {"Measure": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Total Amount"},
                     "Name": "Orders.Total Amount"},
                ],
            },
        },
    )
    implicit_agg = _visual(
        "v2", 640, 0, 320, 160,
        {
            "visualType": "card",
            "objects": _title("Total Orders"),
            "prototypeQuery": {
                "From": [{"Name": "o", "Entity": "Orders"}],
                "Select": [
                    {"Aggregation": {
                        "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OrderID"}},
                        "Function": 4,
                    }, "Name": "Count(Orders.OrderID)"},
                ],
            },
        },
    )
    textbox = _visual(
        "v3", 0, 320, 960, 80,
        {
            "visualType": "textbox",
            "objects": {"general": [{"properties": {"paragraphs": [
                {"textRuns": [{"value": "Migrated from Power BI."}]}
            ]}}]},
        },
    )
    slicer = _visual(
        "v4", 960, 0, 320, 160,
        {
            "visualType": "slicer",
            "prototypeQuery": {
                "From": [{"Name": "o", "Entity": "Orders"}],
                "Select": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Region"},
                            "Name": "Orders.Region"}],
            },
        },
    )
    shape = _visual("v5", 0, 400, 100, 100, {"visualType": "shape"})
    unknown_group = _visual("v6", 0, 500, 100, 100, raw_config=json.dumps({"name": "v6"}))  # no singleVisual

    return {
        "sections": [
            {
                "displayName": "Sales Overview", "name": "S1", "width": 1280, "height": 720,
                "visualContainers": [column_chart, implicit_agg, textbox, slicer, shape, unknown_group],
            }
        ]
    }


def _dash():
    (d,) = translate_powerbi_layout(_layout())
    return d


def test_bounded_pbix_container_recovers_report_layout_without_claiming_vertipaq(tmp_path: Path):
    """This synthetic OPC container proves byte transport and Report/Layout decoding only.

    It intentionally has no DataModel part, so it cannot and must not be treated as evidence that
    pbixray recovered a representative VertiPaq semantic model.
    """
    artifact = tmp_path / "synthetic-layout-only.pbix"
    encoded_layout = json.dumps(_layout()).encode("utf-16")
    assert len(encoded_layout) < 100_000
    with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("Report/Layout", encoded_layout)

    with zipfile.ZipFile(artifact) as archive:
        assert "DataModel" not in archive.namelist()
        assert archive.getinfo("Report/Layout").file_size == len(encoded_layout)
    parsed = load_layout(artifact)
    assert parsed["sections"][0]["displayName"] == "Sales Overview"
    assert translate_powerbi_layout(parsed)[0].name == "Sales Overview"


def test_query_tile_translated():
    d = _dash()
    by_title = {t.title: t for t in d.tiles}
    chart = by_title["Revenue by Month"]
    assert chart.chart_type == "column"
    assert chart.query.topic == "orders"
    assert chart.query.fields == ["orderdate", "total_amount"]
    # 1280px page, 12-col grid: x=0 w=640/1280*12=6
    assert (chart.layout.x, chart.layout.w) == (0, 6)


def test_textbox_becomes_markdown_tile():
    d = _dash()
    by_title = {t.title: t for t in d.tiles}
    notes = by_title[None]
    assert notes.kind == "markdown"
    assert notes.vis_config["body"] == "Migrated from Power BI."


def test_implicit_aggregate_flagged_not_guessed():
    d = _dash()
    titles = {t.title for t in d.tiles}
    assert "Total Orders" not in titles  # no resolvable field -> no query, no tile
    reasons = " ".join(n.reason for n in d.untranslatable)
    assert "implicit aggregate" in reasons
    assert "function code 4" in reasons


def test_slicer_becomes_dashboard_filter_not_tile():
    d = _dash()
    assert len(d.filters) == 1
    assert d.filters[0].field == "region"
    assert all(t.title != "Region" for t in d.tiles)


def test_decorative_and_unknown_visuals_skipped_and_flagged():
    d = _dash()
    reasons = " ".join(n.reason for n in d.untranslatable)
    assert "Decorative" in reasons
    assert "visual group" in reasons or "combo visual" in reasons
    # only the column chart and textbox became tiles (card + slicer + shape + group did not)
    assert len(d.tiles) == 2


def test_attach_visual_aggregate_hints_routes_to_underlying_view():
    """Mirrors the Metabase fix for ad-hoc dashboard SQL: an implicit visual aggregate (Power
    BI's "drag a raw column onto a visual, pick Sum" pattern) is real business logic the
    deterministic model pass can't see on its own. Before this, it only ever reached the
    dashboard-migration AI's seed prompt (as a per-tile hint) — never the modeling AI's, so a
    measure it implies had no path onto the model. This should be called at model-extraction
    time (`extractors/powerbi/extractor.py`), not just dashboard-migration time."""
    views = {"orders": ViewIR(name="orders", source_table="Orders")}
    attach_visual_aggregate_hints(_layout(), views)
    notes = views["orders"].untranslatable
    assert len(notes) == 1
    assert "implicit" in notes[0].reason.lower()
    assert notes[0].hint and "function code 4" in notes[0].hint
    assert "OrderID" in notes[0].hint


def test_attach_visual_aggregate_hints_skips_unknown_tables():
    """A table the model extraction never produced a ViewIR for (e.g. filtered out, or from a
    different .pbix) must not raise or fabricate a view — just skip it."""
    attach_visual_aggregate_hints(_layout(), {})  # no views at all; should not raise

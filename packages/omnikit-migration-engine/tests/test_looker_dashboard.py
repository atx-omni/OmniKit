"""Looker dashboard JSON -> DashboardIR, dialect resolution, dashboard seed prompt."""

from __future__ import annotations

import json
from pathlib import Path

import httpx

from omni_migrator.core.contracts import ApiInput, ExtractCtx, FileInput
from omni_migrator.extractors.looker.api import LookerApi, normalize_looker_dialect
from omni_migrator.extractors.looker.dashboard import (
    translate_looker_dashboard,
    translate_looker_dashboard_lookml,
)
from omni_migrator.extractors.looker.extractor import LookerExtractor, resolve_dialects

FIXTURES = Path(__file__).parent / "fixtures"


def _dash():
    return translate_looker_dashboard(json.loads((FIXTURES / "looker_dashboard.json").read_text()))


# --- dashboard translation ---

def test_dashboard_tiles_and_filters():
    d = _dash()
    assert d.name == "Exec KPIs"
    # e4 (merge) is dropped to untranslatable; e1/e2/e3 become tiles
    assert len(d.tiles) == 3
    assert any("Merged" in n.object for n in d.untranslatable)

    by_title = {t.title: t for t in d.tiles}
    e1 = by_title["Revenue by Month"]
    assert e1.chart_type == "column"
    assert e1.query.topic == "order_items"
    assert e1.query.fields == ["order_items.created_month", "order_items.total_revenue"]
    assert e1.query.filters[0].field == "order_items.status"
    assert e1.query.limit == 500
    # 24-col -> 12-col: column 0 width 12 -> x=0 w=6
    assert (e1.layout.x, e1.layout.w, e1.layout.h) == (0, 6, 6)

    e2 = by_title["Total Revenue"]
    assert e2.chart_type == "kpi"
    assert (e2.layout.x, e2.layout.w) == (6, 6)  # column 12 -> x=6

    e3 = by_title["Notes"]
    assert e3.kind == "markdown"
    assert e3.layout.w == 12  # width 24 -> 12

    assert d.filters[0].field == "order_items.created_date"
    assert d.filters[0].values == ["30 days"]


def test_dashboard_lookml_translation_preserves_queries_and_layout_intent():
    dashboard = translate_looker_dashboard_lookml({
        "dashboard": "sales",
        "title": "Sales overview",
        "filters": [{"name": "Date", "field": "orders.created_date", "default_value": "30 days"}],
        "elements": [
            {
                "name": "revenue",
                "title": "Revenue",
                "explore": "orders",
                "type": "looker_line",
                "fields": ["orders.created_date", "orders.revenue"],
                "listen": {"Date": "orders.created_date"},
            },
        ],
    })
    assert dashboard.name == "Sales overview"
    assert dashboard.filters[0].field == "orders.created_date"
    assert dashboard.filters[0].values == ["30 days"]
    assert dashboard.tiles[0].chart_type == "line"
    assert dashboard.tiles[0].query.topic == "orders"
    assert dashboard.tiles[0].query.fields == ["orders.created_date", "orders.revenue"]
    assert dashboard.tiles[0].vis_config["listen"] == {"Date": "orders.created_date"}


def test_looker_extractor_includes_dashboard_lookml(tmp_path):
    path = tmp_path / "sales.dashboard.lookml"
    path.write_text("""- dashboard: sales\n  title: Sales overview\n  elements:\n  - name: revenue\n    explore: orders\n    type: single_value\n    fields: [orders.revenue]\n""")
    result = LookerExtractor().extract(FileInput(paths=[path]), ExtractCtx())
    assert len(result.dashboards) == 1
    assert result.dashboards[0].name == "Sales overview"
    assert result.dashboards[0].tiles[0].chart_type == "kpi"


# --- dialect resolution via Looker connections API ---

def test_normalize_looker_dialect():
    assert normalize_looker_dialect("bigquery_standard_sql") == "bigquery"
    assert normalize_looker_dialect("snowflake") == "snowflake"
    assert normalize_looker_dialect("spark") == "databricks"
    assert normalize_looker_dialect("weird") == "other"


def test_resolve_dialects_from_connection_name():
    model = LookerExtractor().extract(
        FileInput(paths=[FIXTURES / "order_items.model.lkml"]), ExtractCtx()
    ).model
    # the model file declares connection: "ecommerce"
    assert all(v.connection.source_connection_name == "ecommerce" for v in model.views)
    n = resolve_dialects(model, {"ecommerce": "snowflake"})
    assert n == len(model.views)
    assert all(v.connection.dialect == "snowflake" for v in model.views)


def _conn_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/api/4.0/login":
        return httpx.Response(200, json={"access_token": "t"})
    if request.url.path == "/api/4.0/connections":
        return httpx.Response(200, json=[
            {"name": "ecommerce", "dialect_name": "snowflake"},
            {"name": "legacy", "dialect": {"name": "bigquery_standard_sql"}},
        ])
    return httpx.Response(404)


def test_api_connection_dialects():
    api = LookerApi(
        base_url="https://co.looker.com", client_id="i", client_secret="s",
        transport=httpx.MockTransport(_conn_handler),
    )
    dialects = api.connection_dialects()
    assert dialects == {"ecommerce": "snowflake", "legacy": "bigquery"}


def test_looker_api_project_reuses_file_parser_and_selected_dashboards(monkeypatch):
    closed = {"value": False}

    class FakeLookerApi:
        def __init__(self, **_kwargs):
            pass

        def list_projects(self):
            return [{"id": "food-service"}]

        def connection_dialects(self):
            return {"ecommerce": "snowflake"}

        def get_dashboard(self, dashboard_id):
            assert dashboard_id == "northstar-dashboard"
            return json.loads((FIXTURES / "looker_dashboard.json").read_text())

        def close(self):
            closed["value"] = True

    def fake_project_files(_api, project_id):
        assert project_id == "food-service"
        return {
            "order_items.view.lkml": (FIXTURES / "orders.view.lkml").read_text(),
            "order_items.model.lkml": (FIXTURES / "order_items.model.lkml").read_text(),
        }

    monkeypatch.setattr("omni_migrator.extractors.looker.extractor.LookerApi", FakeLookerApi)
    monkeypatch.setattr("omni_migrator.extractors.looker.extractor.fetch_lookml_files", fake_project_files)
    bundle = LookerExtractor().extract(
        ApiInput(base_url="https://co.looker.com", auth={"client_id": "id", "client_secret": "secret"}),
        ExtractCtx(scope={"project_id": "food-service", "selected_dashboard_ids": ["northstar-dashboard"]}),
    )

    assert bundle.model.views
    assert all(view.connection.dialect == "snowflake" for view in bundle.model.views)
    assert bundle.dashboards[0].name == "Exec KPIs"
    assert bundle.dashboards[0].native_source_id == str(json.loads((FIXTURES / "looker_dashboard.json").read_text())["id"])
    assert bundle.dashboards[0].selection_aliases == [bundle.dashboards[0].native_source_id]
    assert all(tile.native_source_id for tile in bundle.dashboards[0].tiles)
    assert "secret" not in bundle.model_dump_json()
    assert closed["value"] is True

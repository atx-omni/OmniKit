"""Looker dashboard JSON -> DashboardIR, dialect resolution, dashboard seed prompt."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import yaml

from omni_migrator.core.contracts import ApiInput, ExtractCtx, FileInput
from omni_migrator.extractors.looker.api import LookerApi, normalize_looker_dialect
from omni_migrator.extractors.looker.closure import analyze_looker_dependency_closure
from omni_migrator.extractors.looker.dashboard import (
    translate_looker_dashboard,
    translate_looker_dashboard_lookml,
)
from omni_migrator.extractors.looker.extractor import LookerExtractor, resolve_dialects
from omni_migrator.deterministic.model_emitter import emit_model

FIXTURES = Path(__file__).parent / "fixtures"


def _dash():
    return translate_looker_dashboard(json.loads((FIXTURES / "looker_dashboard.json").read_text()))


def test_professional_fixture_contract_is_complete_and_synthetic():
    manifest = json.loads((FIXTURES / "looker_professional_manifest.json").read_text())
    expected = manifest["expected_constructs"]
    assert manifest["schema_version"] == "omnikit.looker.professional.v2"
    assert manifest["synthetic"] is True
    assert set(expected.values()) <= {"automatic", "decision_required", "manual", "unsupported"}
    assert {
        "parameter", "same_view_filtered_measure", "cross_view_filtered_measure",
        "native_derived_table", "filter_expression", "dynamic_group_by",
        "dynamic_filtered_measure", "hidden_fields", "pivot", "filter_listener",
        "visual_configuration", "merged_query", "markdown",
    } <= set(expected)


def test_professional_semantic_fixture_emits_safe_translations_and_typed_requirements():
    bundle = LookerExtractor().extract(
        FileInput(paths=[
            FIXTURES / "looker_professional.view.lkml",
            FIXTURES / "looker_professional.model.lkml",
        ]),
        ExtractCtx(),
    )
    views = {view.name: view for view in bundle.model.views}
    fields = {field.name: field for field in views["example_orders"].fields}

    assert fields["segment_mode"].kind == "parameter"
    assert fields["segment_mode"].suggestion_list == [
        {"value": "enterprise", "label": "Enterprise"},
        {"value": "commercial", "label": "Commercial"},
    ]
    assert fields["completed_order_count"].filters == {"status": {"is": "completed"}}
    assert fields["enterprise_order_count"].filters is None

    requirements = {(item.object_type, item.name): item for item in bundle.model.requirements}
    assert requirements[("parameter", "example_orders.segment_mode")].support_outcome == "decision_required"
    assert requirements[("filtered_measure", "example_orders.enterprise_order_count")].config["filters"] == {
        "example_accounts.segment": {"is": "enterprise"},
    }
    assert requirements[("derived_table", "derived table example_order_rollup")].support_outcome == "manual"
    assert any(item.object_type == "always_filter" for item in bundle.model.requirements)
    assert any(item.object_type == "access_filter" for item in bundle.model.requirements)

    files = emit_model(bundle.model)
    view_yaml = yaml.safe_load(files["analytics/example_orders.view"])
    assert view_yaml["filters"]["segment_mode"]["filter_single_select_only"] is True
    assert view_yaml["measures"]["completed_order_count"]["filters"] == {"status": {"is": "completed"}}
    topic_yaml = yaml.safe_load(files["example_orders.topic"])
    assert topic_yaml["always_where_filters"] == {"example_orders.status": {"not": "cancelled"}}
    assert topic_yaml["access_filters"] == [
        {"field": "example_accounts.segment", "user_attribute": "account_segment"},
    ]


# --- dashboard translation ---

def test_dashboard_tiles_and_filters():
    d = _dash()
    assert d.name == "Exec KPIs"
    # Merged results remain visible as an explicit manual outcome instead of disappearing.
    assert len(d.tiles) == 4
    assert any("Merged" in n.object for tile in d.tiles for n in tile.untranslatable)

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


def test_professional_dashboard_preserves_query_semantics_and_filter_matrix():
    payload = json.loads((FIXTURES / "looker_professional_dashboard.json").read_text())
    dashboard = translate_looker_dashboard(payload)

    assert dashboard.folder_path == "Shared analytics"
    assert dashboard.tile_order == ["tile-1", "tile-2", "tile-3"]
    query = next(tile.query for tile in dashboard.tiles if tile.native_source_id == "tile-1")
    assert query is not None
    assert query.filter_expression == "${example_orders.order_count} > 0"
    assert query.hidden_fields == ["example_orders.order_count"]
    assert query.pivots == ["example_accounts.segment"]
    assert [item.category for item in query.dynamic_fields] == ["group_by", "filtered_measure"]
    assert query.dynamic_fields[0].support_outcome == "automatic"
    assert query.dynamic_fields[1].support_outcome == "automatic"
    assert "example_orders.order_count" in query.calculation_dependencies
    tile = next(tile for tile in dashboard.tiles if tile.native_source_id == "tile-1")
    assert tile.vis_config["stacking"] == "normal"
    assert len(dashboard.filter_bindings) == len(dashboard.filters) * len(dashboard.tiles)
    included = [item for item in dashboard.filter_bindings if item.tile_id == "tile-1" and not item.excluded]
    assert {item.dashboard_filter_label for item in included} == {"Date", "Status"}
    excluded = [item for item in dashboard.filter_bindings if item.tile_id == "tile-3"]
    assert excluded and all(item.excluded for item in excluded)


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


def test_looker_api_fetches_authoritative_dashboard_details_with_bounded_retry():
    attempts = {"elements": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/4.0/login":
            return httpx.Response(200, json={"access_token": "t"})
        if request.url.path == "/api/4.0/dashboards/professional-dashboard":
            return httpx.Response(200, json={"id": "professional-dashboard", "title": "Example", "dashboard_elements": [{"id": "stale"}]})
        if request.url.path.endswith("/dashboard_elements"):
            attempts["elements"] += 1
            if attempts["elements"] == 1:
                return httpx.Response(429, headers={"Retry-After": "0"})
            return httpx.Response(200, json=[{"id": "tile-1"}])
        if request.url.path.endswith("/dashboard_filters"):
            return httpx.Response(200, json=[{"id": "date-filter"}])
        return httpx.Response(404)

    api = LookerApi(
        base_url="https://example.looker.com", client_id="i", client_secret="s",
        transport=httpx.MockTransport(handler),
    )
    dashboard = api.get_dashboard_complete("professional-dashboard")
    assert dashboard["dashboard_elements"][0]["id"] == "tile-1"
    assert dashboard["dashboard_elements"][0]["_omnikit_query_origin"] == "unknown"
    assert dashboard["_omnikit_acquisition"]["unresolved_element_ids"] == ["tile-1"]
    assert dashboard["dashboard_filters"] == [{"id": "date-filter"}]
    assert dashboard["_omnikit_acquisition"]["contract"] == "looker-professional-v2"
    assert attempts["elements"] == 2
    assert "client_secret" not in json.dumps(dashboard)


def test_looker_api_resolves_and_caches_saved_look_queries():
    attempts = {"look": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/4.0/login":
            return httpx.Response(200, json={"access_token": "t"})
        if request.url.path == "/api/4.0/dashboards/saved-look-dashboard":
            return httpx.Response(200, json={"id": "saved-look-dashboard", "title": "Saved Looks"})
        if request.url.path.endswith("/dashboard_elements"):
            return httpx.Response(200, json=[
                {"id": "tile-1", "title": "Revenue", "look_id": "42", "vis_config": {"type": "looker_column"}},
                {"id": "tile-2", "title": "Revenue detail", "look_id": "42", "vis_config": {"type": "table"}},
            ])
        if request.url.path.endswith("/dashboard_filters"):
            return httpx.Response(200, json=[])
        if request.url.path == "/api/4.0/looks/42":
            attempts["look"] += 1
            return httpx.Response(200, json={
                "id": "42",
                "query": {
                    "id": "9001", "model": "commerce", "view": "orders",
                    "fields": ["orders.created_month", "orders.revenue"],
                },
            })
        return httpx.Response(404)

    api = LookerApi(
        base_url="https://example.looker.com", client_id="i", client_secret="s",
        transport=httpx.MockTransport(handler),
    )
    payload = api.get_dashboard_complete("saved-look-dashboard")
    dashboard = translate_looker_dashboard(payload)
    assert attempts["look"] == 1
    assert payload["_omnikit_acquisition"]["look_ids"] == ["42"]
    assert payload["_omnikit_acquisition"]["query_ids"] == ["9001"]
    assert payload["_omnikit_acquisition"]["unresolved_element_ids"] == []
    assert all(tile.query is not None for tile in dashboard.tiles)
    assert all(tile.query.query_origin == "saved_look" for tile in dashboard.tiles)
    assert all(tile.query.source_look_id == "42" for tile in dashboard.tiles)


def test_looker_api_resolves_query_id_when_look_detail_has_no_inline_query():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/4.0/login":
            return httpx.Response(200, json={"access_token": "t"})
        if request.url.path == "/api/4.0/looks/42":
            return httpx.Response(200, json={"id": "42", "query_id": "9001"})
        if request.url.path == "/api/4.0/queries/9001":
            return httpx.Response(200, json={
                "id": "9001", "model": "commerce", "view": "orders",
                "fields": ["orders.revenue"],
            })
        return httpx.Response(404)

    api = LookerApi(
        base_url="https://example.looker.com", client_id="i", client_secret="s",
        transport=httpx.MockTransport(handler),
    )
    query, origin, look_id = api.resolve_element_query({"id": "tile-1", "look_id": "42"})
    assert query["id"] == "9001"
    assert origin == "query_id"
    assert look_id == "42"


def test_manual_saved_look_companion_resolves_or_blocks(tmp_path):
    dashboard_path = tmp_path / "sales.dashboard.lookml"
    dashboard_path.write_text("""- dashboard: sales
  title: Sales overview
  elements:
  - name: saved_revenue
    title: Saved revenue
    look_id: 42
    type: looker_column
""")
    missing = LookerExtractor().extract(FileInput(paths=[dashboard_path]), ExtractCtx())
    assert missing.acquisition.saved_look_coverage == "blocked"
    assert missing.dashboards[0].tiles[0].query is None
    assert missing.dashboards[0].tiles[0].untranslatable[0].severity == "blocker"

    look_path = tmp_path / "sales.look.json"
    look_path.write_text(json.dumps({
        "id": "42",
        "query": {
            "id": "9001", "model": "commerce", "view": "orders",
            "fields": ["orders.created_month", "orders.revenue"],
        },
    }))
    resolved = LookerExtractor().extract(
        FileInput(paths=[dashboard_path, look_path]), ExtractCtx(),
    )
    query = resolved.dashboards[0].tiles[0].query
    assert query is not None
    assert query.query_origin == "saved_look"
    assert query.source_look_id == "42"
    assert resolved.acquisition.saved_look_coverage == "complete"
    assert resolved.acquisition.look_ids == ["42"]
    assert resolved.acquisition.query_ids == ["9001"]


def test_looker_api_project_reuses_file_parser_and_selected_dashboards(monkeypatch):
    closed = {"value": False}

    class FakeLookerApi:
        def __init__(self, **_kwargs):
            pass

        def list_projects(self):
            return [{"id": "food-service"}]

        def connection_dialects(self):
            return {"ecommerce": "snowflake"}

        def get_dashboard_complete(self, dashboard_id):
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


def test_professional_manual_and_api_acquisition_share_one_canonical_contract(monkeypatch, tmp_path):
    model_path = tmp_path / "example_model.model.lkml"
    model_path.write_text((FIXTURES / "looker_professional.model.lkml").read_text())
    view_path = tmp_path / "looker_professional.view.lkml"
    view_path.write_text((FIXTURES / "looker_professional.view.lkml").read_text())
    dashboard_path = tmp_path / "professional.dashboard.lookml"
    dashboard_path.write_text("""- dashboard: professional_dashboard
  title: Example operations overview
  folder: Shared analytics
  filters:
  - name: Date
    title: Date
    type: date_filter
    field: example_orders.created_date
    default_value: 30 days
  elements:
  - name: orders_by_month
    title: Orders by month
    model: example_model
    explore: example_orders
    type: looker_line
    fields: [example_orders.created_month, example_orders.order_count]
    filters: { example_orders.status: completed }
    sorts: [example_orders.created_month desc]
    pivots: [example_accounts.segment]
    limit: 500
    row: 0
    column: 0
    width: 24
    height: 6
    listen: { Date: example_orders.created_date }
""")
    manual = LookerExtractor().extract(
        FileInput(paths=[
            view_path,
            model_path,
            dashboard_path,
        ]),
        ExtractCtx(),
    )
    resolve_dialects(manual.model, {"example_warehouse": "snowflake"})

    api_dashboard = {
        "id": "professional_dashboard",
        "title": "Example operations overview",
        "folder": {"name": "Shared analytics"},
        "dashboard_filters": [{
            "id": "date-filter", "name": "Date", "title": "Date",
            "type": "date_filter", "dimension": "example_orders.created_date",
            "default_value": "30 days",
        }],
        "dashboard_layouts": [{"dashboard_layout_components": [{
            "dashboard_element_id": "orders_by_month", "row": 0, "column": 0,
            "width": 24, "height": 6,
        }]}],
        "dashboard_elements": [{
            "id": "orders_by_month", "title": "Orders by month",
            "vis_config": {"type": "looker_line"},
            "result_maker": {
                "query": {
                    "model": "example_model", "view": "example_orders",
                    "fields": ["example_orders.created_month", "example_orders.order_count"],
                    "filters": {"example_orders.status": "completed"},
                    "sorts": ["example_orders.created_month desc"],
                    "pivots": ["example_accounts.segment"], "limit": 500,
                },
                "filterables": [{"listen": {"Date": "example_orders.created_date"}}],
            },
        }],
    }

    class FakeLookerApi:
        def __init__(self, **_kwargs):
            pass

        def list_projects(self):
            return [{"id": "professional"}]

        def connection_dialects(self):
            return {"example_warehouse": "snowflake"}

        def get_dashboard_complete(self, dashboard_id):
            assert dashboard_id == "professional_dashboard"
            return api_dashboard

        def close(self):
            pass

    def fake_project_files(_api, project_id):
        assert project_id == "professional"
        return {
            "looker_professional.view.lkml": (FIXTURES / "looker_professional.view.lkml").read_text(),
            "example_model.model.lkml": (FIXTURES / "looker_professional.model.lkml").read_text(),
        }

    monkeypatch.setattr("omni_migrator.extractors.looker.extractor.LookerApi", FakeLookerApi)
    monkeypatch.setattr("omni_migrator.extractors.looker.extractor.fetch_lookml_files", fake_project_files)
    api = LookerExtractor().extract(
        ApiInput(base_url="https://example.looker.com", auth={"client_id": "id", "client_secret": "secret"}),
        ExtractCtx(scope={"project_id": "professional", "selected_dashboard_ids": ["professional_dashboard"]}),
    )

    def dashboard_projection(dashboard):
        return {
            "name": dashboard.name,
            "folder_path": dashboard.folder_path,
            "filters": sorted((item.label, item.field, tuple(item.values)) for item in dashboard.filters),
            "tiles": sorted((
                item.title,
                item.kind,
                item.chart_type,
                tuple(item.query.fields if item.query else []),
                tuple(sorted((flt.field, tuple(flt.values)) for flt in (item.query.filters if item.query else []))),
                tuple(json.dumps(sort, sort_keys=True) for sort in (item.query.sorts if item.query else [])),
                item.query.limit if item.query else None,
                tuple(item.query.pivots or []) if item.query else (),
                (item.layout.x, item.layout.y, item.layout.w, item.layout.h),
            ) for item in dashboard.tiles),
            "bindings": sorted((item.dashboard_filter_label, item.target_field, item.excluded) for item in dashboard.filter_bindings),
        }

    assert manual.model.model_dump(mode="json") == api.model.model_dump(mode="json")
    assert dashboard_projection(manual.dashboards[0]) == dashboard_projection(api.dashboards[0])
    assert manual.acquisition is not None
    assert api.acquisition is not None
    assert manual.acquisition.contract_version == api.acquisition.contract_version == "looker.evidence.v1"
    assert manual.acquisition.mode == "manual"
    assert api.acquisition.mode == "api"
    assert manual.acquisition.dashboard_ids == api.acquisition.dashboard_ids == ["professional_dashboard"]
    assert api.acquisition.project_ids == ["professional"]
    assert manual.acquisition.dependency_closure_status == "complete"
    assert api.acquisition.dependency_closure_status == "complete"
    assert not [item for item in manual.acquisition.dependencies if item.required and item.status == "missing"]
    assert api.acquisition.source_query_validation_status == "not_evaluated"
    assert "secret" not in api.model_dump_json()


def _closure_dashboard(model: str = "commerce", explore: str = "orders"):
    return translate_looker_dashboard({
        "id": "selected-dashboard",
        "title": "Selected dashboard",
        "dashboard_elements": [{
            "id": "selected-tile",
            "title": "Selected tile",
            "vis_config": {"type": "looker_column"},
            "query": {
                "model": model,
                "view": explore,
                "fields": [f"{explore}.id", "customers.name"],
            },
        }],
    })


def test_dependency_closure_resolves_nested_include_globs_and_excludes_unrelated_gaps(tmp_path):
    model = tmp_path / "commerce.model.lkml"
    model.write_text('''connection: "warehouse"\ninclude: "/views/**/*.view.lkml"\nexplore: orders { join: customers { sql_on: ${orders.customer_id} = ${customers.id} ;; } }\n''')
    views = tmp_path / "views" / "core"
    views.mkdir(parents=True)
    orders = views / "orders.view.lkml"
    orders.write_text('''view: orders { dimension: id { primary_key: yes sql: ${TABLE}.id ;; } dimension: customer_id { sql: ${TABLE}.customer_id ;; } }\n''')
    customers = views / "customers.view.lkml"
    customers.write_text('''view: customers { dimension: id { primary_key: yes sql: ${TABLE}.id ;; } dimension: name { sql: ${TABLE}.name ;; } }\n''')
    unrelated = tmp_path / "views" / "unrelated.view.lkml"
    unrelated.write_text('''view: unrelated { extends: [missing_parent] dimension: id { sql: ${TABLE}.id ;; } }\n''')

    report = analyze_looker_dependency_closure(
        [model, orders, customers, unrelated],
        [_closure_dashboard()],
        source_root=tmp_path,
    )

    assert report.status == "complete"
    assert "views/unrelated.view.lkml" in report.unrelated_files
    assert not [item for item in report.dependencies if item.required and item.status == "missing"]
    assert {item.reference for item in report.dependencies if item.kind == "view" and item.status == "resolved"} >= {"orders", "customers"}


def test_dependency_closure_blocks_missing_include_and_duplicate_required_view(tmp_path):
    missing_model = tmp_path / "commerce.model.lkml"
    missing_model.write_text('''include: "/missing/*.view.lkml"\nexplore: orders {}\n''')
    missing = analyze_looker_dependency_closure(
        [missing_model],
        [_closure_dashboard()],
        source_root=tmp_path,
    )
    assert missing.status == "blocked"
    assert any(item.kind == "include" and item.status == "missing" for item in missing.dependencies)

    first = tmp_path / "first.view.lkml"
    second = tmp_path / "second.view.lkml"
    first.write_text('''view: orders { dimension: id { sql: ${TABLE}.id ;; } }\n''')
    second.write_text('''view: orders { dimension: id { sql: ${TABLE}.other_id ;; } }\n''')
    missing_model.write_text('''include: "/*.view.lkml"\nexplore: orders {}\n''')
    duplicate = analyze_looker_dependency_closure(
        [missing_model, first, second],
        [_closure_dashboard(explore="orders")],
        source_root=tmp_path,
    )
    assert duplicate.status == "blocked"
    assert any(item.kind == "view" and "duplicate definitions" in item.message for item in duplicate.dependencies)


def test_dependency_closure_resolves_manifest_constants_and_remote_projects(tmp_path):
    main = tmp_path / "main"
    shared = tmp_path / "shared"
    (main / "models").mkdir(parents=True)
    (main / "views").mkdir(parents=True)
    (shared / "views").mkdir(parents=True)
    model = main / "models" / "commerce.model.lkml"
    model.write_text('''include: "/views/*.view.lkml"\ninclude: "//shared/views/*.view.lkml"\nexplore: orders { join: customers { sql_on: ${orders.customer_id} = ${customers.id} ;; } }\n''')
    orders = main / "views" / "orders.view.lkml"
    orders.write_text('''view: orders { sql_table_name: @{warehouse_schema}.orders ;; dimension: id { sql: ${TABLE}.id ;; } dimension: customer_id { sql: ${TABLE}.customer_id ;; } }\n''')
    customers = shared / "views" / "customers.view.lkml"
    customers.write_text('''view: customers { dimension: id { sql: ${TABLE}.id ;; } dimension: name { sql: ${TABLE}.name ;; } }\n''')
    manifest = main / "manifest.lkml"
    manifest.write_text('''constant: warehouse_schema { value: "analytics" }\nremote_dependency: shared { url: "git@example.invalid/shared.git" ref: "main" }\n''')

    report = analyze_looker_dependency_closure(
        [model, orders, customers, manifest],
        [_closure_dashboard()],
        project_ids=["main", "shared"],
        source_root=tmp_path,
    )

    assert report.status == "complete"
    assert any(item.kind == "constant" and item.reference == "warehouse_schema" and item.status == "resolved" for item in report.dependencies)
    assert any(item.kind == "manifest_dependency" and item.reference == "shared" and item.status == "resolved" for item in report.dependencies)
    assert "main/manifest.lkml" in report.required_files


def test_dependency_closure_blocks_missing_manifest_constant_and_remote_project(tmp_path):
    main = tmp_path / "main"
    (main / "models").mkdir(parents=True)
    (main / "views").mkdir(parents=True)
    model = main / "models" / "commerce.model.lkml"
    model.write_text('''include: "/views/*.view.lkml"\ninclude: "//shared/views/*.view.lkml"\nexplore: orders {}\n''')
    orders = main / "views" / "orders.view.lkml"
    orders.write_text('''view: orders { sql_table_name: @{warehouse_schema}.orders ;; dimension: id { sql: ${TABLE}.id ;; } }\n''')

    report = analyze_looker_dependency_closure(
        [model, orders],
        [_closure_dashboard()],
        project_ids=["main", "shared"],
        source_root=tmp_path,
    )

    assert report.status == "blocked"
    missing = {(item.kind, item.reference) for item in report.dependencies if item.status == "missing"}
    assert ("constant", "warehouse_schema") in missing
    assert ("manifest_dependency", "shared") in missing

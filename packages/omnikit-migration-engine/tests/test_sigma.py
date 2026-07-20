"""Sigma data-model spec -> IR. `_build_bundle` takes a plain dict (the shape `SigmaApi.snapshot()`
returns), so these tests build fixtures inline instead of hitting a real instance — same
offline-testing shape as `test_metabase.py`. No live instance to verify the actual wire shapes
against (plan §6.4), especially `relationships`/`metrics` (not shown verbatim in Sigma's public
docs) — these tests lock in the *documented* pieces (`columns[]`, `source.path`) and the
best-effort assumed shapes for the rest."""

from __future__ import annotations

from omni_migrator.core.contracts import ExtractCtx
from omni_migrator.extractors.sigma.extractor import _build_bundle


def _snapshot(**overrides) -> dict:
    base = {
        "connections": [{"connectionId": "c1", "name": "Warehouse", "type": "bigQuery"}],
        "dataModels": [
            {
                "dataModelId": "dm1",
                "spec": {
                    "pages": [{
                        "elements": [
                            {
                                "id": "e1", "kind": "table", "name": "Order Items",
                                "source": {
                                    "connectionId": "c1", "kind": "warehouse-table",
                                    "path": ["db", "public", "order_items"],
                                },
                                "columns": [
                                    {"id": "col-id", "name": "id"},
                                    {"id": "col-price", "name": "Sale Price"},
                                ],
                            },
                            {
                                "id": "e2", "kind": "table", "name": "Inventory Items",
                                "source": {
                                    "connectionId": "c1", "kind": "warehouse-table",
                                    "path": ["db", "public", "inventory_items"],
                                },
                                "columns": [{"id": "col-inv-id", "name": "id"}],
                            },
                        ],
                    }],
                    "relationships": [],
                    "metrics": [],
                },
            }
        ],
    }
    base.update(overrides)
    return base


def test_physical_columns_and_dialect():
    bundle = _build_bundle(_snapshot())
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    assert orders.connection.dialect == "bigquery"
    assert orders.schema_name == "public" and orders.source_table == "order_items"
    assert {f.name for f in orders.fields} == {"id", "sale_price"}
    price = next(f for f in orders.fields if f.name == "sale_price")
    assert price.sql == "sale_price"


def test_workbook_scope_expands_only_selected_workbook_pages_with_aliases():
    workbooks = [
        {"workbookId": "wb-1", "name": "Keep", "pages": [{"id": "page-1", "name": "Overview", "elements": []}]},
        {"workbookId": "wb-2", "name": "Exclude", "pages": [{"id": "page-2", "name": "Other", "elements": []}]},
    ]
    bundle = _build_bundle(_snapshot(workbooks=workbooks), ExtractCtx(scope={"selected_dashboard_ids": ["wb-1"]}))
    assert [dashboard.name for dashboard in bundle.dashboards] == ["Overview"]
    assert bundle.dashboards[0].native_source_id == "page-1"
    assert bundle.dashboards[0].selection_aliases == ["wb-1", "page-1"]


def test_calculated_column_becomes_note_not_field():
    """Mirrors Power BI's DAX-calculated-column posture — a formula that isn't a bare passthrough
    is row-context Sigma-formula logic with no deterministic Omni equivalent; flagged, never a
    fabricated `FieldIR`."""
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["pages"][0]["elements"][0]["columns"].append(
        {"id": "col-calc", "name": "Full Name", "formula": '[First Name] + " " + [Last Name]'}
    )
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    assert not any(f.name == "full_name" for f in orders.fields)
    assert any("calculated column" in n.object and "Full Name" in n.object for n in orders.untranslatable)


def test_passthrough_formula_is_treated_as_plain_column():
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["pages"][0]["elements"][0]["columns"].append(
        {"id": "col-status", "name": "Status", "formula": "[Status]"}
    )
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    assert any(f.name == "status" for f in orders.fields)
    assert not any("Status" in n.object for n in orders.untranslatable if "calculated" in n.reason)


def test_metric_resolves_to_real_measure():
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["metrics"] = [
        {"id": "m1", "name": "Total Revenue", "elementId": "e1", "formula": "Sum([Sale Price])"}
    ]
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    measure = next(f for f in orders.fields if f.name == "total_revenue")
    assert measure.kind == "measure" and measure.aggregate == "sum" and measure.sql == "sale_price"


def test_metric_sum_if_becomes_filtered_measure():
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["metrics"] = [{
        "id": "m2", "name": "Completed Revenue", "elementId": "e1",
        "formula": 'SumIf([Sale Price], [Status] = "Complete")',
    }]
    snapshot["dataModels"][0]["spec"]["pages"][0]["elements"][0]["columns"].append(
        {"id": "col-status", "name": "Status"}
    )
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    measure = next(f for f in orders.fields if f.name == "completed_revenue")
    assert measure.aggregate == "sum" and measure.filters == {"status": {"is": "Complete"}}


def test_unresolvable_metric_is_untranslatable():
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["metrics"] = [
        {"id": "m3", "name": "Bad Metric", "elementId": "e1", "formula": "Lookup(x, y, z)"}
    ]
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    assert not any(f.name == "bad_metric" for f in orders.fields)
    assert any("Bad Metric" in n.object for n in orders.untranslatable)


def test_relationship_becomes_topic_join_with_scoped_names():
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["relationships"] = [
        {"fromElementId": "e1", "fromColumnId": "col-price", "toElementId": "e2", "toColumnId": "col-inv-id", "type": "many-to-one"}
    ]
    bundle = _build_bundle(snapshot)
    (topic,) = bundle.model.topics
    assert topic.base_view == "order_items"
    (join,) = topic.joins
    assert join.join_from_view == "order_items" and join.join_to_view == "inventory_items"
    assert join.relationship_type == "many_to_one"
    assert join.on_sql == "${order_items.sale_price} = ${inventory_items.id}"
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    assert any("not verified" in n.reason.lower() for n in orders.untranslatable)


def test_relationship_one_to_one_type():
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["relationships"] = [
        {"fromElementId": "e1", "fromColumnId": "col-price", "toElementId": "e2", "toColumnId": "col-inv-id", "type": "one-to-one"}
    ]
    bundle = _build_bundle(snapshot)
    (topic,) = bundle.model.topics
    assert topic.joins[0].relationship_type == "one_to_one"


def test_element_missing_source_path_still_gets_a_view():
    """An element name (not the physical table name) can still anchor a view even with no
    schema/table path — matches how a derived/no-path element degrades gracefully rather than
    being dropped."""
    snapshot = _snapshot()
    snapshot["dataModels"][0]["spec"]["pages"][0]["elements"].append(
        {"id": "e3", "kind": "table", "name": "Ad Hoc", "source": {}, "columns": [{"id": "col-x", "name": "X"}]}
    )
    bundle = _build_bundle(snapshot)
    assert any(v.name == "ad_hoc" for v in bundle.model.views)


def test_normalize_unknown_connection_type_falls_back_to_other():
    snapshot = _snapshot(connections=[{"connectionId": "c1", "name": "Mystery", "type": "some-future-warehouse"}])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "order_items")
    assert orders.connection.dialect == "other"

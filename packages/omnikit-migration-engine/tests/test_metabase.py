"""Metabase REST API (databases/tables/fields/segments/metrics) -> IR.

`_build_bundle` takes a plain dict (the shape `MetabaseApi.snapshot()` returns), so these tests
build fixtures inline instead of hitting a real instance — same offline-testing shape as
`test_powerbi.py`'s duck-typed fake (Metabase's API is already plain JSON, so no wrapper class
is needed here).
"""

from __future__ import annotations

from omni_migrator.core.contracts import ExtractCtx
from omni_migrator.extractors.metabase.extractor import _build_bundle


def _snapshot(**overrides) -> dict:
    base = {
        "databases": [{"id": 1, "name": "Warehouse", "engine": "postgres"}],
        "tables": [
            {
                "id": 100, "db_id": 1, "name": "orders", "schema": "public",
                "fields": [
                    {"id": 10, "name": "id", "base_type": "type/BigInteger", "semantic_type": "type/PK"},
                    {"id": 11, "name": "amount", "base_type": "type/Float"},
                    {"id": 12, "name": "status", "base_type": "type/Text"},
                    {
                        "id": 13, "name": "customer_id", "base_type": "type/Integer",
                        "semantic_type": "type/FK", "fk_target_field_id": 20,
                    },
                ],
            },
            {
                "id": 200, "db_id": 1, "name": "customers", "schema": "public",
                "fields": [
                    {"id": 20, "name": "id", "base_type": "type/BigInteger", "semantic_type": "type/PK"},
                    {"id": 21, "name": "name", "base_type": "type/Text"},
                ],
            },
        ],
        "segments": [],
        "metrics": [],
        "cards": [],
    }
    base.update(overrides)
    return base


def test_physical_columns_and_dialect():
    bundle = _build_bundle(_snapshot())
    orders = next(v for v in bundle.model.views if v.name == "orders")
    assert orders.connection.dialect == "postgres"
    assert {f.name for f in orders.fields} == {"id", "amount", "status", "customer_id"}
    assert orders.primary_key_field == "id"
    amount = next(f for f in orders.fields if f.name == "amount")
    assert amount.data_type == "number" and amount.sql == "amount"


def test_dashboard_scope_preserves_native_ids_and_does_not_expand_selection():
    dashboards = [
        {"id": 41, "name": "Keep", "dashcards": [], "parameters": []},
        {"id": 42, "name": "Exclude", "dashcards": [], "parameters": []},
    ]
    bundle = _build_bundle(_snapshot(dashboards=dashboards), ExtractCtx(scope={"selected_dashboard_ids": ["41"]}))
    assert [dashboard.name for dashboard in bundle.dashboards] == ["Keep"]
    assert bundle.dashboards[0].native_source_id == "41"
    assert bundle.dashboards[0].selection_aliases == ["41"]


def test_fk_becomes_topic_join_with_inferred_cardinality_note():
    bundle = _build_bundle(_snapshot())
    (topic,) = bundle.model.topics
    assert topic.base_view == "orders"
    (join,) = topic.joins
    assert join.join_from_view == "orders" and join.join_to_view == "customers"
    assert join.relationship_type == "many_to_one"
    assert join.on_sql == "${orders.customer_id} = ${customers.id}"
    orders = next(v for v in bundle.model.views if v.name == "orders")
    assert any("inferred" in n.reason for n in orders.untranslatable)


def test_segment_compiles_to_yesno_dimension():
    snapshot = _snapshot(segments=[
        {
            "id": 1, "table_id": 100, "name": "Completed orders",
            "definition": {"filter": ["=", ["field", 12, None], "completed"]},
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    seg = next(f for f in orders.fields if f.name == "completed_orders")
    assert seg.data_type == "boolean" and seg.sql == "status = 'completed'"


def test_segment_or_filter_is_untranslatable():
    snapshot = _snapshot(segments=[
        {
            "id": 2, "table_id": 100, "name": "A or B",
            "definition": {"filter": ["or", ["=", ["field", 12, None], "a"], ["=", ["field", 12, None], "b"]]},
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    assert not any(f.name == "a_or_b" for f in orders.fields)
    assert any("A or B" in n.object for n in orders.untranslatable)


def test_legacy_metric_deterministic():
    snapshot = _snapshot(metrics=[
        {
            "id": 1, "table_id": 100, "name": "Total Revenue",
            "definition": {"aggregation": [["sum", ["field", 11, None]]]},
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    measure = next(f for f in orders.fields if f.name == "total_revenue")
    assert measure.kind == "measure" and measure.aggregate == "sum" and measure.sql == "amount"


def test_metric_type_card_count_where_with_filters():
    snapshot = _snapshot(metrics=[
        {
            "id": 2, "type": "metric", "name": "Completed order count",
            "dataset_query": {
                "type": "query",
                "query": {"source-table": 100, "aggregation": [["count-where", ["=", ["field", 12, None], "completed"]]]},
            },
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    measure = next(f for f in orders.fields if f.name == "completed_order_count")
    assert measure.aggregate == "count"
    assert measure.filters == {"status": {"is": "completed"}}


def test_metric_cross_table_is_untranslatable():
    snapshot = _snapshot(metrics=[
        {
            "id": 3, "table_id": 100, "name": "Bad metric",
            "definition": {"aggregation": [["sum", ["field", 21, None]]]},  # customers.name, wrong table
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    assert not any(f.name == "bad_metric" for f in orders.fields)
    assert any("Bad metric" in n.object for n in orders.untranslatable)


def test_native_sql_model_becomes_derived_table_view():
    snapshot = _snapshot(cards=[
        {
            "id": 1, "type": "model", "name": "Recent Orders",
            "dataset_query": {"type": "native", "database": 1, "native": {"query": "select * from orders where status = {{status}}"}},
        }
    ])
    bundle = _build_bundle(snapshot)
    model_view = next(v for v in bundle.model.views if v.name == "recent_orders")
    assert model_view.sql == "select * from orders where status = {{status}}"
    assert model_view.connection.dialect == "postgres"
    assert any("template-tag" in n.reason for n in model_view.untranslatable)


def test_mbql_model_flagged_untranslatable_at_model_level():
    snapshot = _snapshot(cards=[
        {
            "id": 2, "type": "model", "name": "Orders MBQL Model",
            "dataset_query": {"type": "query", "database": 1, "query": {"source-table": 100}},
        }
    ])
    bundle = _build_bundle(snapshot)
    assert not any(v.name == "orders_mbql_model" for v in bundle.model.views)
    assert any("Orders MBQL Model" in n.object for n in bundle.model.untranslatable)


def test_native_sql_question_card_hints_the_touched_views():
    """A plain dashboard question (not a saved Metric) computing `sum(amount)` joined against
    `customers` should surface that raw SQL as a hint on *both* touched views' `untranslatable`
    — so it reaches the per-view modeling AI seed prompt, not just the dashboard-migration one."""
    snapshot = _snapshot(cards=[
        {
            "id": 5, "type": "question", "name": "Revenue by Customer",
            "dataset_query": {
                "type": "native", "database": 1,
                "native": {"query": "select c.name, sum(o.amount) as revenue from orders o "
                                     "join customers c on c.id = o.customer_id group by 1"},
            },
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    customers = next(v for v in bundle.model.views if v.name == "customers")
    for view in (orders, customers):
        note = next(n for n in view.untranslatable if "Revenue by Customer" in n.object)
        assert "sum(o.amount)" in note.hint
        assert note.severity == "info"


def test_sql_join_inferred_when_no_fk_metadata():
    """Real-world schemas are often synced into Metabase with zero DB-level FK constraints (a
    live Metabase instance used to build this had `semantic_type: type/FK` on *none* of its
    fields) — when `_build_joins` finds nothing, a dashboard card's native-SQL `JOIN ... ON`
    clause is the next best signal for the relationship."""
    tables_no_fk = [
        {
            "id": 100, "db_id": 1, "name": "orders", "schema": "public",
            "fields": [
                {"id": 10, "name": "id", "base_type": "type/BigInteger", "semantic_type": "type/PK"},
                {"id": 11, "name": "amount", "base_type": "type/Float"},
                {"id": 13, "name": "customer_id", "base_type": "type/Integer"},
            ],
        },
        {
            "id": 200, "db_id": 1, "name": "customers", "schema": "public",
            "fields": [
                {"id": 20, "name": "id", "base_type": "type/BigInteger", "semantic_type": "type/PK"},
                {"id": 21, "name": "name", "base_type": "type/Text"},
            ],
        },
    ]
    snapshot = _snapshot(tables=tables_no_fk, cards=[
        {
            "id": 6, "type": "question", "name": "Revenue by Customer",
            "dataset_query": {
                "type": "native", "database": 1,
                "native": {"query": "select c.name, sum(o.amount) from orders o "
                                     "join customers c on c.id = o.customer_id group by 1"},
            },
        }
    ])
    bundle = _build_bundle(snapshot)
    assert not bundle.model.topics == []  # a topic was inferred despite no FK metadata
    (topic,) = bundle.model.topics
    assert topic.base_view == "orders"
    (join,) = topic.joins
    assert join.join_from_view == "orders" and join.join_to_view == "customers"
    assert join.relationship_type == "many_to_one"
    assert join.on_sql == "${orders.customer_id} = ${customers.id}"
    orders = next(v for v in bundle.model.views if v.name == "orders")
    assert any("Revenue by Customer" in n.reason for n in orders.untranslatable)


def test_sql_inferred_join_skipped_when_fk_relationship_already_exists():
    """FK metadata (when present) wins — a dashboard SQL join for the same view pair must not
    add a second, duplicate relationship."""
    snapshot = _snapshot(cards=[
        {
            "id": 6, "type": "question", "name": "Revenue by Customer",
            "dataset_query": {
                "type": "native", "database": 1,
                "native": {"query": "select c.name, sum(o.amount) from orders o "
                                     "join customers c on c.id = o.customer_id group by 1"},
            },
        }
    ])
    bundle = _build_bundle(snapshot)
    (topic,) = bundle.model.topics
    assert len(topic.joins) == 1


def test_metric_and_model_cards_are_not_double_hinted():
    """`type: metric`/`type: model` cards are already compiled/flagged elsewhere
    (`_build_metrics`/`_build_models`) — `_build_card_hints` should skip them entirely."""
    snapshot = _snapshot(cards=[
        {
            "id": 9, "type": "metric", "name": "Total Revenue",
            "dataset_query": {"type": "native", "database": 1, "native": {"query": "select sum(amount) from orders"}},
        }
    ])
    bundle = _build_bundle(snapshot)
    orders = next(v for v in bundle.model.views if v.name == "orders")
    assert not any("Total Revenue" in n.object for n in orders.untranslatable)

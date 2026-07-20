"""Unit tests for `deterministic/mbql_translate.py`, directly against its pure functions —
mirrors `test_powerbi.py::test_dax_translate_helper_directly`'s style, one case per shape."""

from omni_migrator.deterministic.mbql_translate import (
    FieldMeta,
    normalize_query_stage,
    resolve_field_ref,
    translate_aggregation,
    translate_expression,
    translate_filter_clause,
    translate_filter_to_conditions,
    translate_measure_filter,
)

ORDERS = 1
CUSTOMERS = 2
FIELDS = {
    10: FieldMeta(view="orders", name="id", table_id=ORDERS),
    11: FieldMeta(view="orders", name="amount", table_id=ORDERS),
    12: FieldMeta(view="orders", name="status", table_id=ORDERS),
    13: FieldMeta(view="orders", name="customer_id", table_id=ORDERS),
    20: FieldMeta(view="customers", name="name", table_id=CUSTOMERS),
}


def field(id_, **opts):
    return ["field", id_, opts or None]


# --- resolve_field_ref ---

def test_resolve_field_ref_own_table():
    col, reason = resolve_field_ref(field(11), FIELDS, ORDERS)
    assert (col, reason) == ("amount", None)


def test_resolve_field_ref_cross_table():
    col, reason = resolve_field_ref(field(20), FIELDS, ORDERS)
    assert col is None and "another table" in reason


def test_resolve_field_ref_joined_source_field():
    col, reason = resolve_field_ref(field(20, **{"source-field": 13}), FIELDS, ORDERS)
    assert col is None and "join" in reason


def test_resolve_field_ref_nested_alias():
    col, reason = resolve_field_ref(["field", "amount_alias", None], FIELDS, ORDERS)
    assert col is None and "nested-query alias" in reason


# --- translate_aggregation ---

def test_aggregation_count():
    sql, agg, filters, reason = translate_aggregation(["count"], FIELDS, ORDERS)
    assert (sql, agg, filters, reason) == (None, "count", None, None)


def test_aggregation_sum_own_table():
    sql, agg, filters, reason = translate_aggregation(["sum", field(11)], FIELDS, ORDERS)
    assert (sql, agg, filters, reason) == ("amount", "sum", None, None)


def test_aggregation_distinct():
    sql, agg, filters, reason = translate_aggregation(["distinct", field(13)], FIELDS, ORDERS)
    assert (sql, agg, filters, reason) == ("customer_id", "count_distinct", None, None)


def test_aggregation_options_wrapper():
    clause = ["aggregation-options", ["sum", field(11)], {"display-name": "Total"}]
    sql, agg, filters, reason = translate_aggregation(clause, FIELDS, ORDERS)
    assert (sql, agg, filters, reason) == ("amount", "sum", None, None)


def test_aggregation_count_where_simple():
    clause = ["count-where", ["=", field(12), "completed"]]
    sql, agg, filters, reason = translate_aggregation(clause, FIELDS, ORDERS)
    assert reason is None
    assert (sql, agg) == (None, "count")
    assert filters == {"status": {"is": "completed"}}


def test_aggregation_sum_where_and_of_distinct_fields():
    clause = [
        "sum-where", field(11),
        ["and", ["=", field(12), "completed"], ["!=", field(13), 5]],
    ]
    sql, agg, filters, reason = translate_aggregation(clause, FIELDS, ORDERS)
    assert reason is None
    assert (sql, agg) == ("amount", "sum")
    assert filters == {"status": {"is": "completed"}, "customer_id": {"is_not": 5}}


def test_aggregation_sum_where_or_is_untranslatable():
    clause = ["sum-where", field(11), ["or", ["=", field(12), "a"], ["=", field(12), "b"]]]
    sql, agg, filters, reason = translate_aggregation(clause, FIELDS, ORDERS)
    assert sql is None and agg is None and filters is None and reason


def test_aggregation_cross_table_is_untranslatable():
    sql, agg, filters, reason = translate_aggregation(["sum", field(20)], FIELDS, ORDERS)
    assert sql is None and agg is None and filters is None and "another table" in reason


def test_aggregation_cum_sum_is_untranslatable():
    sql, agg, filters, reason = translate_aggregation(["cum-sum", field(11)], FIELDS, ORDERS)
    assert sql is None and agg is None and filters is None
    assert "no deterministic Omni equivalent" in reason


# --- translate_measure_filter (narrow: verified `is`/`is_not` wire shape only) ---

def test_measure_filter_equals():
    filters, reason = translate_measure_filter(["=", field(12), "completed"], FIELDS, ORDERS)
    assert reason is None and filters == {"status": {"is": "completed"}}


def test_measure_filter_not_equals():
    filters, reason = translate_measure_filter(["!=", field(12), "completed"], FIELDS, ORDERS)
    assert reason is None and filters == {"status": {"is_not": "completed"}}


def test_measure_filter_between_is_unverified_shape_untranslatable():
    filters, reason = translate_measure_filter(["between", field(11), 0, 100], FIELDS, ORDERS)
    assert filters is None and "simple equals/not-equals" in reason


def test_measure_filter_repeated_field_untranslatable():
    clause = ["and", ["=", field(12), "a"], ["=", field(12), "b"]]
    filters, reason = translate_measure_filter(clause, FIELDS, ORDERS)
    assert filters is None and "same field" in reason


# --- translate_filter_clause (rich: raw SQL, for segments) ---

def test_filter_clause_equals():
    sql, reason = translate_filter_clause(["=", field(12), "completed"], FIELDS, ORDERS)
    assert reason is None and sql == "status = 'completed'"


def test_filter_clause_between():
    sql, reason = translate_filter_clause(["between", field(11), 0, 100], FIELDS, ORDERS)
    assert reason is None and sql == "amount BETWEEN 0 AND 100"


def test_filter_clause_and_of_two():
    clause = ["and", ["=", field(12), "completed"], [">", field(11), 0]]
    sql, reason = translate_filter_clause(clause, FIELDS, ORDERS)
    assert reason is None and sql == "(status = 'completed' AND amount > 0)"


def test_filter_clause_not():
    sql, reason = translate_filter_clause(["not", ["=", field(12), "completed"]], FIELDS, ORDERS)
    assert reason is None and sql == "NOT (status = 'completed')"


def test_filter_clause_contains():
    sql, reason = translate_filter_clause(["contains", field(12), "ship"], FIELDS, ORDERS)
    assert reason is None and sql == "status LIKE '%ship%'"


def test_filter_clause_or_is_untranslatable():
    clause = ["or", ["=", field(12), "a"], ["=", field(12), "b"]]
    sql, reason = translate_filter_clause(clause, FIELDS, ORDERS)
    assert sql is None and "OR filter clauses" in reason


def test_filter_clause_time_interval_is_untranslatable():
    sql, reason = translate_filter_clause(["time-interval", field(11), -7, "day"], FIELDS, ORDERS)
    assert sql is None and "Relative-date filter" in reason


# --- translate_filter_to_conditions (rich, FilterIR-shaped tuples for dashboard/query filters) ---

def test_filter_to_conditions_equals():
    conds, reason = translate_filter_to_conditions(["=", field(12), "completed"], FIELDS, ORDERS)
    assert reason is None and conds == [("status", "equals", ["completed"], False)]


def test_filter_to_conditions_not_equals_is_negative():
    conds, reason = translate_filter_to_conditions(["!=", field(12), "completed"], FIELDS, ORDERS)
    assert reason is None and conds == [("status", "equals", ["completed"], True)]


def test_filter_to_conditions_and_flattens():
    clause = ["and", ["=", field(12), "completed"], [">", field(11), 0]]
    conds, reason = translate_filter_to_conditions(clause, FIELDS, ORDERS)
    assert reason is None
    assert conds == [("status", "equals", ["completed"], False), ("amount", "greater_than", ["0"], False)]


def test_filter_to_conditions_or_is_untranslatable():
    clause = ["or", ["=", field(12), "a"], ["=", field(12), "b"]]
    conds, reason = translate_filter_to_conditions(clause, FIELDS, ORDERS)
    assert conds is None and "OR filter clauses" in reason


def test_filter_to_conditions_not_null():
    conds, reason = translate_filter_to_conditions(["not-null", field(12)], FIELDS, ORDERS)
    assert reason is None and conds == [("status", "is_empty", [], True)]


# --- translate_expression (pure arithmetic only) ---

def test_expression_arithmetic():
    expr = ["+", field(11), 5]
    sql, reason = translate_expression(expr, FIELDS, ORDERS)
    assert reason is None and sql == "(amount) + (5)"


def test_expression_nested_arithmetic():
    expr = ["*", ["-", field(11), 1], 2]
    sql, reason = translate_expression(expr, FIELDS, ORDERS)
    assert reason is None and sql == "((amount) - (1)) * (2)"


def test_expression_case_is_untranslatable():
    expr = ["case", [[["=", field(12), "a"], 1]], {"default": 0}]
    sql, reason = translate_expression(expr, FIELDS, ORDERS)
    assert sql is None and "needs AI translation" in reason


# --- normalize_query_stage (pMBQL "stages" wire format, verified live against v0.62 — a card's
# dataset_query inserts a `{"lib/uuid": ...}` options dict as every clause's 2nd element instead of
# the legacy `[op, id, opts]` shape every parser above assumes) ---

def _opts(**extra):
    return {"lib/uuid": "test-uuid", **extra}


def test_normalize_native_stage_string_shape():
    dq = {"lib/type": "mbql/query", "database": 2,
          "stages": [{"lib/type": "mbql.stage/native", "native": "select 1"}]}
    is_native, q = normalize_query_stage(dq)
    assert is_native and q == {"query": "select 1", "template-tags": {}}


def test_normalize_native_stage_dict_shape():
    """Legacy-style `native: {query, template-tags}` dict, still under the new `stages` wrapper."""
    dq = {"stages": [{"lib/type": "mbql.stage/native",
                       "native": {"query": "select {{x}}", "template-tags": {"x": {}}}}]}
    is_native, q = normalize_query_stage(dq)
    assert is_native and q["query"] == "select {{x}}" and list(q["template-tags"]) == ["x"]


def test_normalize_legacy_shape_passthrough():
    dq = {"type": "query", "query": {"source-table": ORDERS, "aggregation": [["count"]]}}
    is_native, q = normalize_query_stage(dq)
    assert not is_native and q == {"source-table": ORDERS, "aggregation": [["count"]]}


def test_normalize_pmbql_field_ref_repositions_opts_to_legacy_slot():
    dq = {"stages": [{"source-table": ORDERS, "aggregation": [["count", _opts()]],
                       "breakout": [["field", _opts(**{"temporal-unit": "month"}), 11]]}]}
    _, q = normalize_query_stage(dq)
    ref = q["breakout"][0]
    assert ref[0] == "field" and ref[1] == 11 and ref[2]["temporal-unit"] == "month"


def test_normalize_pmbql_metric_ref_and_breakout_resolve_end_to_end():
    """The exact shape Metabase v0.62 returns for a Metric-backed, breakout-only card —
    reproduces the live dashboard-migration bug this normalizer fixes."""
    dq = {"lib/type": "mbql/query", "database": 2, "stages": [{
        "lib/type": "mbql.stage/mbql", "source-table": ORDERS,
        "aggregation": [["metric", _opts(), 99]],
        "breakout": [["field", _opts(**{"base-type": "type/Text"}), 12]],
    }]}
    is_native, q = normalize_query_stage(dq)
    assert not is_native
    assert q["source-table"] == ORDERS
    assert q["aggregation"] == [["metric", 99]]
    col, reason = resolve_field_ref(q["breakout"][0], FIELDS, ORDERS)
    assert (col, reason) == ("status", None)


def test_normalize_pmbql_filters_list_becomes_singular_and_clause():
    dq = {"stages": [{
        "source-table": ORDERS,
        "filters": [
            ["=", _opts(), ["field", _opts(), 12], "Complete"],
            ["=", _opts(), ["field", _opts(), 11], 100],
        ],
    }]}
    _, q = normalize_query_stage(dq)
    assert q["filter"][0] == "and"
    sql, reason = translate_filter_clause(q["filter"], FIELDS, ORDERS)
    assert reason is None and sql == "(status = 'Complete' AND amount = 100)"


def test_normalize_pmbql_single_filter_not_and_wrapped():
    dq = {"stages": [{"source-table": ORDERS,
                       "filters": [["=", _opts(), ["field", _opts(), 12], "Complete"]]}]}
    _, q = normalize_query_stage(dq)
    assert q["filter"][0] == "="  # not wrapped in `and` when there's only one


def test_normalize_pmbql_source_field_join_still_detected():
    """The one thing in the opts dict any parser reads (join detection) survives normalization."""
    dq = {"stages": [{"source-table": ORDERS,
                       "breakout": [["field", _opts(**{"source-field": 13}), 20]]}]}
    _, q = normalize_query_stage(dq)
    col, reason = resolve_field_ref(q["breakout"][0], FIELDS, ORDERS)
    assert col is None and "source-field" in reason

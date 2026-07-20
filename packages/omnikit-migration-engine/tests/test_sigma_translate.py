"""Deterministic Sigma formula -> Omni measure mapping. No live instance to verify wire shapes
against (plan §6.4) — these lock in behavior against the worked examples Sigma's own public docs
give (`SumIf`, `Lookup`) plus the documented function-index vocabulary."""

from __future__ import annotations

from omni_migrator.deterministic.sigma_translate import parse_ref, translate_condition, translate_formula


def test_parse_ref_same_table():
    assert parse_ref("[Sales]") == (None, "Sales")


def test_parse_ref_cross_table():
    assert parse_ref("[Sales Amounts/Sales Amount]") == ("Sales Amounts", "Sales Amount")


def test_parse_ref_rejects_non_ref_text():
    assert parse_ref("Sum([Sales])") is None


def test_plain_sum_wrapper():
    sql, agg, filters, reason = translate_formula("Sum([Sale Price])", home_table="order_items")
    assert (sql, agg, filters, reason) == ("sale_price", "sum", None, None)


def test_bare_count_no_args():
    assert translate_formula("Count()") == (None, "count", None, None)


def test_count_distinct():
    sql, agg, filters, reason = translate_formula("CountDistinct([User Id])")
    assert (sql, agg) == ("user_id", "count_distinct")


def test_sum_if_doc_example_with_or_is_untranslatable():
    """The exact worked example from `help.sigmacomputing.com/reference/sumif` — OR conditions
    have no deterministic Omni measure-filter equivalent, same posture as MBQL's `translate_measure_filter`."""
    sql, agg, filters, reason = translate_formula(
        'SumIf([Sales], [Store State] = "Michigan" or [Store State] = "California")'
    )
    assert sql is None and agg is None and filters is None
    assert "OR" in reason


def test_sum_if_and_condition_resolves_to_filters_dict():
    sql, agg, filters, reason = translate_formula(
        'SumIf([Sale Price], [Status] = "Complete" and [Region] = "West")', home_table="order_items",
    )
    assert reason is None
    assert (sql, agg) == ("sale_price", "sum")
    assert filters == {"status": {"is": "Complete"}, "region": {"is": "West"}}


def test_count_if_condition_only_arity():
    sql, agg, filters, reason = translate_formula('CountIf([Status] = "Complete")')
    assert reason is None
    assert (sql, agg, filters) == (None, "count", {"status": {"is": "Complete"}})


def test_avg_if_not_equals():
    sql, agg, filters, reason = translate_formula('AvgIf([Sale Price], [Status] != "Cancelled")')
    assert reason is None
    assert filters == {"status": {"is_not": "Cancelled"}}


def test_lookup_doc_example_is_untranslatable():
    """The exact worked example from `help.sigmacomputing.com/reference/lookup`."""
    _, _, _, reason = translate_formula(
        "Lookup(Sum([Sales Amounts/Sales Amount]), [Order Number], [Sales Amounts/Order Number])"
    )
    assert reason is not None and "Lookup" in reason


def test_window_family_is_untranslatable():
    _, _, _, reason = translate_formula("WindowSum([Sales])")
    assert reason is not None and "Window" in reason


def test_cross_table_reference_needs_ai():
    _, _, _, reason = translate_formula("Sum([Sales Amounts/Sales Amount])", home_table="order_items")
    assert reason is not None and "another table" in reason


def test_nested_or_in_condition_is_untranslatable():
    filters, reason = translate_condition('[A] = "x" or [B] = "y"')
    assert filters is None and "OR" in reason


def test_duplicate_field_condition_needs_ai():
    filters, reason = translate_condition('[Status] = "A" and [Status] = "B"')
    assert filters is None and "Multiple conditions" in reason


def test_unrecognized_formula_is_untranslatable():
    _, _, _, reason = translate_formula("[First Name] + \" \" + [Last Name]")
    assert reason is not None


def test_empty_formula_is_untranslatable():
    assert translate_formula("")[3] is not None
    assert translate_formula(None)[3] is not None

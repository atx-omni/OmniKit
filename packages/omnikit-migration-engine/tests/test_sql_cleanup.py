"""Deterministic SQL cleanup: `${TABLE}` stripping + source-function fixups.

These run inside every extractor and again as an emit-time backstop in
`model_emitter`, so neither the `${TABLE}` token nor known function quirks
(`ISNULL`, `DATEPART`, ...) should ever need explaining to the agentic API.
"""

from __future__ import annotations

from omni_migrator.deterministic.sql_cleanup import clean_sql, strip_table_token
from omni_migrator.extractors.looker.extractor import _dimension, _measure


def test_strip_table_token():
    assert strip_table_token("${TABLE}.amount") == "amount"
    assert strip_table_token("${TABLE}.amount > 100") == "amount > 100"
    assert strip_table_token("${other_field}") == "${other_field}"  # field refs untouched
    assert strip_table_token(None) is None
    assert strip_table_token("") == ""


def test_clean_sql_combines_table_strip_and_fixups():
    assert clean_sql("ISNULL(${TABLE}.amount)") == "amount IS NULL"
    assert clean_sql("DATEPART(year, ${TABLE}.created_at)") == "DATE_PART(year, created_at)"
    assert clean_sql(None) is None


def test_looker_dimension_and_measure_sql_is_cleaned():
    # A LookML source can legitimately contain ${TABLE} and SQL-Server-isms (ISNULL/DATEPART)
    # — the extractor must normalize both before the draft ever reaches the agentic prompt.
    dim = _dimension({"name": "is_active", "type": "yesno", "sql": "NOT ISNULL(${TABLE}.deleted_at)"})
    assert dim.sql == "NOT deleted_at IS NULL"

    field, _ = _measure({
        "name": "year_total", "type": "sum",
        "sql": "DATEPART(year, ${TABLE}.amount)",
    })
    assert field.sql == "DATE_PART(year, amount)"

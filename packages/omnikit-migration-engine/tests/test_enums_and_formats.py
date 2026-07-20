from __future__ import annotations

from omni_migrator.deterministic.formats import map_value_format
from omni_migrator.deterministic.omni_enums import (
    OMNI_AGGREGATES,
    OMNI_CHART_TYPES,
    is_valid_format,
)


def test_format_tokens_validate():
    assert is_valid_format("USDCURRENCY_2")
    assert is_valid_format("PERCENT_1")
    assert is_valid_format("NUMBER_0")
    assert is_valid_format("BIGUSDCURRENCY_2")
    assert is_valid_format("MILLIONS")
    assert not is_valid_format("NOTATOKEN_2")
    assert not is_valid_format("USDCURRENCY_99")  # 2-digit decimal not allowed


def test_verified_enums_present():
    for agg in ("sum", "count_distinct", "percentile", "median"):
        assert agg in OMNI_AGGREGATES
    for ct in ("bar_stacked", "point", "kpi", "sankey"):
        assert ct in OMNI_CHART_TYPES


def test_value_format_mapping():
    assert map_value_format("usd", source="looker") == "USDCURRENCY_2"
    assert map_value_format("usd_0", source="looker") == "USDCURRENCY_0"
    assert map_value_format("0.0%") == "PERCENT_1"
    assert map_value_format("$#,##0.00") == "USDCURRENCY_2"
    assert map_value_format("#,##0") == "NUMBER_0"
    assert map_value_format(None) is None
    # Unknown Excel-ish string passes through verbatim.
    assert map_value_format('#,##0.00 "kg"') == '#,##0.00 "kg"'

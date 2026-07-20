"""End-to-end vertical slice: LookML -> IR -> Omni YAML.

The golden output is plan Appendix A.11. Compares parsed YAML structures (not strings)
so formatting is not part of the contract.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from omni_migrator.core.contracts import ExtractCtx, FileInput
from omni_migrator.deterministic.model_emitter import emit_model, emit_view
from omni_migrator.extractors.looker.extractor import LookerExtractor, _measure
from omni_migrator.ir.schema import ViewIR

FIXTURE = Path(__file__).parent / "fixtures" / "orders.view.lkml"


def _extract():
    return LookerExtractor().extract(FileInput(paths=[FIXTURE]), ExtractCtx())


def test_extract_builds_expected_ir():
    bundle = _extract()
    assert bundle.source == "looker"
    (view,) = bundle.model.views
    assert view.name == "orders"
    assert view.schema_name == "analytics"
    assert view.source_table == "orders"
    assert view.primary_key_field == "id"

    by_name = {f.name: f for f in view.fields}
    # dimension_group collapses to ONE timestamp dim named from ${TABLE}.created_at
    assert set(by_name) == {"id", "created_at", "amount", "total_amount", "order_count"}
    assert by_name["created_at"].data_type == "timestamp"
    assert by_name["created_at"].timeframes == ["date", "month", "year"]
    assert by_name["id"].primary_key is True
    assert by_name["amount"].value_format == "USDCURRENCY_2"
    assert by_name["total_amount"].kind == "measure"
    assert by_name["total_amount"].aggregate == "sum"
    assert by_name["order_count"].aggregate == "count"


def test_emit_matches_appendix_a11():
    bundle = _extract()
    emitted = yaml.safe_load(emit_view(bundle.model.views[0]))
    expected = {
        "schema": "analytics",
        "table_name": "orders",
        "dimensions": {
            # no `sql:` — Omni infers the column when it matches the field name
            # (verified live; Omni has no `${TABLE}` token at all).
            # no `type:` either — Omni infers it from the physical column; dimensions
            # don't carry that property (verified live, 400s otherwise; see F3).
            "id": {"primary_key": True},
            "created_at": {},
            "amount": {"format": "USDCURRENCY_2"},
        },
        "measures": {
            "total_amount": {"sql": "${amount}", "aggregate_type": "sum", "format": "USDCURRENCY_2"},
            "order_count": {"aggregate_type": "count"},
        },
    }
    assert emitted == expected


def test_emit_model_paths():
    bundle = _extract()
    files = emit_model(bundle.model)
    # real Omni path convention (verified live): `{schema}/{name}.view`, no `views/`
    # folder, no `.yaml` extension.
    assert "analytics/orders.view" in files
    # round-trips as valid YAML
    assert yaml.safe_load(files["analytics/orders.view"])["table_name"] == "orders"


def test_looker_number_measure_is_preserved_as_compound_omni_measure():
    field, note = _measure({
        "name": "average_bag_size",
        "type": "number",
        "sql": "${total_revenue} / NULLIF(${orders}, 0)",
        "value_format_name": "decimal_2",
    })

    assert note is None
    assert field is not None
    assert field.kind == "measure"
    assert field.aggregate is None
    assert field.sql == "${total_revenue} / NULLIF(${orders}, 0)"
    emitted = yaml.safe_load(emit_view(ViewIR(name="orders", fields=[field])))
    assert emitted["measures"]["average_bag_size"]["sql"] == "${total_revenue} / NULLIF(${orders}, 0)"
    assert "aggregate_type" not in emitted["measures"]["average_bag_size"]


def test_northstar_compound_measure_regressions_are_not_dropped():
    expressions = {
        "average_bag_size": "${total_revenue} / NULLIF(${orders}, 0)",
        "attach_rate": "${add_on_revenue} / NULLIF(${total_revenue}, 0)",
        "discount_rate": "${discounts} / NULLIF(${gross_revenue}, 0)",
        "items_per_bag": "${items} / NULLIF(${bags}, 0)",
        "margin_pct": "${total_gross_margin} / NULLIF(${net_revenue}, 0)",
    }

    fields = []
    for name, sql in expressions.items():
        field, note = _measure({"name": name, "type": "number", "sql": sql})
        assert note is None
        assert field is not None
        fields.append(field)

    assert {field.name for field in fields} == set(expressions)
    emitted = yaml.safe_load(emit_view(ViewIR(name="northstar", fields=fields)))
    assert set(emitted["measures"]) == set(expressions)
    assert all("aggregate_type" not in value for value in emitted["measures"].values())

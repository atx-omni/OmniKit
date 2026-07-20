"""Tableau .tds -> IR -> Omni YAML, incl. snowparser-style calc resolution."""

from __future__ import annotations

import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pytest
import yaml

from omni_migrator.core.contracts import ExtractCtx, FileInput
from omni_migrator.deterministic.model_emitter import emit_view
from omni_migrator.deterministic.sql_cleanup import apply_sql_fixups, bracket_timeframes
from omni_migrator.extractors.tableau.extractor import TableauExtractor, _load_root

FIXTURE = Path(__file__).parent / "fixtures" / "orders.tds"


def _model():
    return TableauExtractor().extract(FileInput(paths=[FIXTURE]), ExtractCtx()).model


def test_table_and_columns():
    model = _model()
    (view,) = model.views
    assert view.name == "orders"
    assert view.schema_name == "PUBLIC"
    assert view.source_table == "ORDERS"
    assert view.connection.dialect == "snowflake"

    by_name = {f.name: f for f in view.fields}
    # physical dimension / measure with sql resolved to the bare remote (physical) column
    # — Omni has no ${TABLE} token (verified live against the real Omni API).
    assert by_name["order_id"].kind == "dimension"
    assert by_name["order_id"].sql == "ID"
    assert by_name["created_at"].data_type == "timestamp"
    assert by_name["amount"].kind == "measure"
    assert by_name["amount"].aggregate == "sum"
    assert by_name["amount"].sql == "AMOUNT"
    # Tableau's role="measure" doesn't say *how* to aggregate — 'sum' is our default, not
    # a derived fact, so it's flagged for the AI to confirm rather than asserted silently.
    reasons = " ".join(n.reason for n in view.untranslatable)
    assert "no explicit aggregation" in reasons


def test_calculated_fields_resolution():
    model = _model()
    by_name = {f.name: f for f in model.views[0].fields}

    # SUM([Amount]) -> measure(sum) with the inner ref resolved to the bare column
    assert by_name["total_amount"].kind == "measure"
    assert by_name["total_amount"].aggregate == "sum"
    assert by_name["total_amount"].sql == "AMOUNT"

    # [Amount] > 100 -> dimension with the ref resolved to the bare column
    assert by_name["big_order"].kind == "dimension"
    assert by_name["big_order"].sql == "AMOUNT > 100"

    # LOD {FIXED ...} -> untranslatable, never emitted as a field
    assert "region_sales" not in by_name
    # notes live on the view (not the model) so they reach the per-view AI seed prompt
    # and the ai_policy="notes" routing decision, both of which key off view.untranslatable
    reasons = " ".join(n.reason for n in model.views[0].untranslatable)
    assert "Level-of-Detail" in reasons


def test_emits_valid_view_yaml():
    view = _model().views[0]
    doc = yaml.safe_load(emit_view(view))
    assert doc["schema"] == "PUBLIC"
    assert doc["table_name"] == "ORDERS"
    assert doc["measures"]["amount"]["aggregate_type"] == "sum"


def test_sql_cleanup_helpers():
    assert apply_sql_fixups("ISNULL(x)") == "x IS NULL"
    assert apply_sql_fixups("DATEPART(year, x)") == "DATE_PART(year, x)"
    assert bracket_timeframes("${created_at_month}") == "${created_at[month]}"
    assert bracket_timeframes("${created_at}") == "${created_at}"


def _joined_model():
    fixture = Path(__file__).parent / "fixtures" / "orders_customers_join.tds"
    return TableauExtractor().extract(FileInput(paths=[fixture]), ExtractCtx()).model


def test_real_join_clause_becomes_topic_join():
    """Regression test: a multi-table datasource used to produce a topic with zero joins,
    silently, no matter what the <relation type='join'>'s <clause> actually said. The join
    clause must now actually be read."""
    model = _joined_model()
    (topic,) = model.topics
    assert topic.base_view == "orders"
    (join,) = topic.joins
    assert join.join_from_view == "orders" and join.join_to_view == "customers"
    assert join.join_type == "always_left"  # from join='left' on the <relation>
    assert join.relationship_type == "many_to_one"
    assert join.on_sql == "${orders.customer_id} = ${customers.id}"


def test_join_key_columns_get_added_as_dimensions_even_when_not_projected():
    """Customer_Id/Id are the join keys but were never in the datasource's <column> list (not
    user-visible fields) — they still need to exist as dimensions for the join to be usable."""
    model = _joined_model()
    by_view = {v.name: v for v in model.views}
    assert any(f.name == "customer_id" for f in by_view["orders"].fields)
    assert any(f.name == "id" for f in by_view["customers"].fields)


def test_join_flagged_as_inferred_not_asserted():
    model = _joined_model()
    orders = next(v for v in model.views if v.name == "orders")
    reasons = " ".join(n.reason for n in orders.untranslatable)
    assert "not asserted metadata" in reasons


def test_ambiguous_multitable_datasource_without_join_clause_is_flagged():
    """A multi-table datasource whose <relation type='join'> has no resolvable <clause> (e.g. a
    chained/multi-way join) must be flagged, not left as a silent empty-joins topic."""
    ds = ET.fromstring("""
        <datasource formatted-name='ds'>
          <connection class='snowflake'>
            <relation type='join' join='inner'>
              <relation name='A' table='[PUBLIC].[A]' type='table' />
              <relation name='B' table='[PUBLIC].[B]' type='table' />
            </relation>
          </connection>
        </datasource>
    """)
    from omni_migrator.extractors.tableau.extractor import _datasource

    views, topic = _datasource(ds, None)
    assert topic is not None and topic.joins == []
    a = next(v for v in views if v.name == "a")
    assert any("chained/multi-way join" in n.reason for n in a.untranslatable)


def _custom_sql_model():
    fixture = Path(__file__).parent / "fixtures" / "custom_sql.tds"
    return TableauExtractor().extract(FileInput(paths=[fixture]), ExtractCtx()).model


def test_custom_sql_datasource_becomes_derived_table_view():
    """Regression test: a 100%-custom-SQL datasource used to synthesize an empty view with zero
    fields and no note at all — silently worse than flagging it untranslatable. It should become
    a real derived-table view (raw SQL verbatim), the same treatment as a Metabase native-SQL
    Model."""
    model = _custom_sql_model()
    (view,) = model.views
    assert view.sql == "SELECT id, amount FROM orders WHERE amount > 0"
    assert view.source_table is None
    by_name = {f.name: f for f in view.fields}
    assert "id" in by_name and "amount" in by_name


def test_packaged_twbx_and_tdsx_are_extracted(tmp_path):
    packaged = [
        ("orders.tdsx", "Data/orders.tds", Path(__file__).parent / "fixtures" / "orders.tds"),
        ("orders.twbx", "Workbook/orders.twb", Path(__file__).parent / "fixtures" / "orders_dashboard.twb"),
    ]

    for archive_name, member_name, source_path in packaged:
        archive = tmp_path / archive_name
        with zipfile.ZipFile(archive, "w") as output:
            output.write(source_path, member_name)
        extractor = TableauExtractor()
        source = FileInput(paths=[archive])

        assert extractor.detect(source) is True
        result = extractor.extract(source, ExtractCtx())
        assert result.source == "tableau"
        assert result.model.views or result.dashboards


def test_rejects_xml_declarations_beyond_the_old_probe_window(tmp_path):
    artifact = tmp_path / "late-declaration.tds"
    artifact.write_bytes(
        (b" " * 1_048_600)
        + b"<!DOCTYPE datasource [<!ENTITY unsafe 'value'>]>"
        + b"<datasource name='unsafe'>&unsafe;</datasource>"
    )

    with pytest.raises(ValueError, match="declarations and entities are not accepted"):
        _load_root(artifact)

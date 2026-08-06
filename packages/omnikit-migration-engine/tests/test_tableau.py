"""Tableau .tds -> IR -> Omni YAML, incl. snowparser-style calc resolution."""

from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pytest
import yaml

from omni_migrator.core.contracts import ExtractCtx, FileInput
from omni_migrator.deterministic.model_emitter import emit_view
from omni_migrator.deterministic.sql_cleanup import apply_sql_fixups, bracket_timeframes
from omni_migrator.extractors.tableau.extractor import TableauExtractor, _datasource, _load_root

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
    # No field-specific default was present, so the documented SUM default is review-visible.
    reasons = " ".join(n.reason for n in view.untranslatable)
    assert "documented SUM default" in reasons


def test_every_semantic_node_has_artifact_scoped_identity_and_direct_evidence():
    actual_sha256 = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
    fingerprint = {"name": "orders-source.tds", "sha256": actual_sha256}
    bundle = TableauExtractor().extract(
        FileInput(paths=[FIXTURE], artifact_metadata={FIXTURE: fingerprint}),
        ExtractCtx(),
    )

    nodes = [
        *bundle.model.views,
        *(field for view in bundle.model.views for field in view.fields),
        *bundle.model.requirements,
    ]
    assert nodes
    for node in nodes:
        assert node.source_id.startswith("tableau:")
        assert node.source_locator.startswith("artifact:orders-source.tds/")
        assert len(node.evidence) == 1
        assert node.evidence[0].artifact_sha256 == actual_sha256
        assert node.evidence[0].role == "direct"
        assert len(node.evidence[0].content_sha256) == 64

    assert bundle.acquisition.contract_version == "tableau.evidence.v1"
    assert bundle.acquisition.dependency_closure_status == "partial"
    assert bundle.acquisition.source_query_validation_status == "not_evaluated"
    assert any("synthetic source IDs" in item for item in bundle.acquisition.diagnostics)


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

    requirements = [
        item for item in model.requirements
        if item.config.get("artifact_class") == "calculation"
    ]
    assert len(requirements) == 1
    assert requirements[0].support_outcome == "unsupported"
    assert requirements[0].config["formula_sha256"]


def test_explicit_default_aggregation_is_preserved():
    datasource = ET.fromstring("""
        <datasource name='sales'>
          <connection class='snowflake'>
            <relation name='SALES' table='[PUBLIC].[SALES]' type='table' />
            <metadata-records>
              <metadata-record class='column'>
                <remote-name>MARGIN</remote-name><local-name>[Margin]</local-name>
              </metadata-record>
            </metadata-records>
          </connection>
          <column caption='Margin' datatype='real' name='[Margin]' role='measure'
                  default-aggregation='Avg' />
        </datasource>
    """)

    views, _ = _datasource(datasource, None)
    assert views[0].fields[0].aggregate == "average"
    assert not any("documented SUM default" in note.reason for note in views[0].untranslatable)


def test_typed_calculation_parser_rejects_compound_aggregates_and_table_calculations():
    datasource = ET.fromstring("""
        <datasource name='sales'>
          <connection class='snowflake'>
            <relation name='SALES' table='[PUBLIC].[SALES]' type='table' />
            <metadata-records>
              <metadata-record class='column'>
                <remote-name>AMOUNT</remote-name><local-name>[Amount]</local-name>
              </metadata-record>
              <metadata-record class='column'>
                <remote-name>ORDER_ID</remote-name><local-name>[Order Id]</local-name>
              </metadata-record>
            </metadata-records>
          </connection>
          <column caption='Amount' datatype='real' name='[Amount]' role='measure' />
          <column caption='Order Id' datatype='string' name='[Order Id]' role='dimension' />
          <column caption='Average Ticket' datatype='real' name='[Average Ticket]' role='measure'>
            <calculation class='tableau' formula='SUM([Amount]) / COUNTD([Order Id])' />
          </column>
          <column caption='Running Amount' datatype='real' name='[Running Amount]' role='measure'>
            <calculation class='tableau' formula='RUNNING_SUM(SUM([Amount]))' />
          </column>
        </datasource>
    """)
    requirements = []

    views, _ = _datasource(datasource, None, requirements=requirements)
    field_names = {field.name for field in views[0].fields}
    assert "average_ticket" not in field_names
    assert "running_amount" not in field_names
    reasons = " ".join(note.reason for note in views[0].untranslatable)
    assert "Compound aggregate calculation is unsupported" in reasons
    assert "Table calculation is unsupported" in reasons
    assert len([item for item in requirements if item.support_outcome == "unsupported"]) == 2


def test_parameters_are_inventory_requirements_and_parameter_calcs_stay_explicit(tmp_path):
    workbook = tmp_path / "parameter-workbook.twb"
    workbook.write_text("""
        <workbook version='2024.1'>
          <datasources>
            <datasource name='Parameters'>
              <column caption='Threshold' datatype='real' name='[Threshold]'
                      param-domain-type='range' value='100'>
                <range min='0' max='1000' granularity='10' />
              </column>
            </datasource>
            <datasource name='sales' caption='Sales'>
              <connection class='snowflake'>
                <relation name='SALES' table='[PUBLIC].[SALES]' type='table' />
                <metadata-records>
                  <metadata-record class='column'>
                    <remote-name>AMOUNT</remote-name><local-name>[Amount]</local-name>
                  </metadata-record>
                </metadata-records>
              </connection>
              <column caption='Amount' datatype='real' name='[Amount]' role='measure' />
              <column caption='Above Threshold' datatype='boolean' name='[Above Threshold]'
                      role='dimension'>
                <calculation class='tableau' formula='[Amount] &gt; [Threshold]' />
              </column>
            </datasource>
          </datasources>
        </workbook>
    """)

    bundle = TableauExtractor().extract(FileInput(paths=[workbook]), ExtractCtx())
    parameter = next(
        item for item in bundle.model.requirements if item.object_type == "parameter"
    )
    assert parameter.support_outcome == "decision_required"
    assert parameter.config["current_value"] == "100"
    assert parameter.config["range"]["max"] == "1000"
    assert "above_threshold" not in {field.name for field in bundle.model.views[0].fields}
    assert any(
        "Parameter-dependent calculation" in note.reason
        for note in bundle.model.views[0].untranslatable
    )


def test_workbook_lineage_inventory_is_explicitly_incomplete(tmp_path):
    workbook = tmp_path / "missing-lineage.twb"
    workbook.write_text("""
        <workbook>
          <datasources>
            <datasource name='embedded' caption='Embedded'>
              <connection class='snowflake'>
                <relation name='ORDERS' table='[PUBLIC].[ORDERS]' type='table' />
              </connection>
            </datasource>
          </datasources>
          <worksheets>
            <worksheet name='Missing source sheet'><table><view><datasources>
              <datasource name='published-not-embedded' caption='Published' />
            </datasources></view><rows/><cols/></table></worksheet>
          </worksheets>
        </workbook>
    """)

    bundle = TableauExtractor().extract(FileInput(paths=[workbook]), ExtractCtx())
    assert bundle.acquisition.dependency_closure_status == "blocked"
    missing = [item for item in bundle.acquisition.dependencies if item.status == "missing"]
    assert [item.reference for item in missing] == [
        "Missing source sheet->published-not-embedded"
    ]
    workbook_requirement = next(
        item for item in bundle.model.requirements
        if item.object_type == "lineage" and item.config.get("source_contract")
    )
    assert workbook_requirement.config["metadata_api_lineage_complete"] is False
    assert workbook_requirement.config["permissions_inventoried"] is False


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


def test_real_join_clause_becomes_reviewable_relationship_requirement():
    """Regression test: a multi-table datasource used to produce a topic with zero joins,
    silently, no matter what the <relation type='join'>'s <clause> actually said. The join
    clause must now actually be read."""
    model = _joined_model()
    (topic,) = model.topics
    assert topic.base_view == "orders"
    assert topic.joins == []
    relationship = next(
        requirement
        for requirement in model.requirements
        if requirement.name == "Tableau join orders to customers"
    )
    assert relationship.support_outcome == "decision_required"
    assert relationship.config["source_join_type"] == "left"
    assert relationship.config["proposed_omni_join_type"] == "always_left"
    assert relationship.config["on_sql_evidence"] == "${orders.customer_id} = ${customers.id}"
    assert relationship.config["relationship_type"] is None
    assert relationship.config["cardinality_is_source_asserted"] is False


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
    assert "does not assert target cardinality" in reasons


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
    assert any("Custom SQL is preserved verbatim" in note.reason for note in view.untranslatable)

    requirement = next(
        item for item in model.requirements if item.object_type == "derived_table"
    )
    assert requirement.support_outcome == "decision_required"
    assert requirement.config["lineage_complete"] is False
    assert requirement.config["sql_preserved_verbatim"] is True


def test_custom_sql_is_not_rewritten_and_tableau_parameter_sql_is_unsupported(tmp_path):
    datasource = tmp_path / "parameterized-custom-sql.tds"
    datasource.write_text("""
        <datasource name='custom'>
          <connection class='snowflake'>
            <relation name='Parameterized SQL' type='text'>
              SELECT 1 &lt;&lt; 2 AS shifted WHERE amount &gt; [Parameters].[Threshold]
            </relation>
          </connection>
        </datasource>
    """)

    bundle = TableauExtractor().extract(FileInput(paths=[datasource]), ExtractCtx())
    assert bundle.model.views[0].sql == (
        "SELECT 1 << 2 AS shifted WHERE amount > [Parameters].[Threshold]"
    )
    requirement = next(
        item for item in bundle.model.requirements if item.object_type == "derived_table"
    )
    assert requirement.support_outcome == "unsupported"
    assert requirement.config["has_tableau_parameter_reference"] is True


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
        assert result.acquisition.dependency_closure_status == "partial"
        assert any(archive_name in item for item in result.acquisition.source_files)


def test_packaged_tableau_rejects_high_ratio_archive_before_xml_materialization(tmp_path):
    archive = tmp_path / "ratio.twbx"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        output.writestr("Workbook/ratio.twb", b"0" * 2_000_000)

    with pytest.raises(ValueError, match="member expansion ratio"):
        _load_root(archive)


def test_rejects_xml_declarations_beyond_the_old_probe_window(tmp_path):
    artifact = tmp_path / "late-declaration.tds"
    artifact.write_bytes(
        (b" " * 1_048_600)
        + b"<!DOCTYPE datasource [<!ENTITY unsafe 'value'>]>"
        + b"<datasource name='unsafe'>&unsafe;</datasource>"
    )

    with pytest.raises(ValueError, match="declarations and entities are not accepted"):
        _load_root(artifact)

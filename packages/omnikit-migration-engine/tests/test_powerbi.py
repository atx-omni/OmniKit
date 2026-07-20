"""Power BI .pbix (VertiPaq data model, via pbixray) -> IR.

`_build_bundle` takes any object exposing pbixray's DataFrame properties, so these
tests use a duck-typed fake instead of a real `.pbix` binary — same offline-testing
shape as the Looker API client's `MockTransport`.
"""

from __future__ import annotations

import sys
import types
import zipfile

import pandas as pd
import yaml

from omni_migrator.core.contracts import ExtractCtx, FileInput
from omni_migrator.deterministic.dax_translate import translate_measure
from omni_migrator.deterministic.model_emitter import emit_view
from omni_migrator.extractors.powerbi.extractor import PowerBIExtractor, _build_bundle


class FakePBIXModel:
    """Duck-typed stand-in for `pbixray.PBIXRay` — same DataFrame-shaped properties."""

    def __init__(self, **frames):
        self._frames = frames

    @property
    def schema(self):
        return self._frames.get("schema", pd.DataFrame())

    @property
    def dax_measures(self):
        return self._frames.get("dax_measures", pd.DataFrame())

    @property
    def dax_columns(self):
        return self._frames.get("dax_columns", pd.DataFrame())

    @property
    def dax_tables(self):
        return self._frames.get("dax_tables", pd.DataFrame())

    @property
    def relationships(self):
        return self._frames.get("relationships", pd.DataFrame())

    @property
    def power_query(self):
        return self._frames.get("power_query", pd.DataFrame())


def _model():
    schema = pd.DataFrame(
        [
            {"TableName": "Orders", "ColumnName": "OrderID", "PandasDataType": "Int64"},
            {"TableName": "Orders", "ColumnName": "Amount", "PandasDataType": "Float64"},
            {"TableName": "Orders", "ColumnName": "CreatedAt", "PandasDataType": "datetime64[ns]"},
            {"TableName": "Orders", "ColumnName": "CustomerID", "PandasDataType": "Int64"},
            {"TableName": "Orders", "ColumnName": "AmountTax", "PandasDataType": "Float64"},
            {"TableName": "Customers", "ColumnName": "CustomerID", "PandasDataType": "Int64"},
            {"TableName": "Customers", "ColumnName": "Name", "PandasDataType": "string"},
            {"TableName": "Date", "ColumnName": "DateKey", "PandasDataType": "datetime64[ns]"},
        ]
    )
    dax_columns = pd.DataFrame(
        [{"TableName": "Orders", "ColumnName": "AmountTax", "Expression": "Orders[Amount] * 1.1"}]
    )
    dax_measures = pd.DataFrame(
        [
            {
                "TableName": "Orders", "Name": "Total Amount",
                "Expression": "SUM ( Orders[Amount] )",
                "DisplayFolder": "Revenue", "Description": "Sum of order amount",
            },
            {
                "TableName": "Orders", "Name": "Order Count",
                "Expression": "COUNTROWS ( Orders )",
                "DisplayFolder": None, "Description": None,
            },
            {
                "TableName": "Orders", "Name": "Avg Days To Ship",
                "Expression": "CALCULATE ( AVERAGE ( Orders[ShipDays] ), Orders[Amount] > 0 )",
                "DisplayFolder": None, "Description": None,
            },
        ]
    )
    dax_tables = pd.DataFrame([{"TableName": "Date", "Expression": "CALENDAR ( DATE(2020,1,1), DATE(2030,1,1) )"}])
    relationships = pd.DataFrame(
        [
            {
                "FromTableName": "Orders", "FromColumnName": "CustomerID",
                "ToTableName": "Customers", "ToColumnName": "CustomerID",
                "IsActive": 1, "Cardinality": "M:1",
            }
        ]
    )
    power_query = pd.DataFrame(
        [{"TableName": "Orders", "Expression": 'Snowflake.Databases("acct.snowflakecomputing.com", "WH")'}]
    )
    return _build_bundle(
        FakePBIXModel(
            schema=schema, dax_columns=dax_columns, dax_measures=dax_measures,
            dax_tables=dax_tables, relationships=relationships, power_query=power_query,
        )
    )


def test_physical_columns_and_dialect():
    bundle = _model()
    views = {v.name: v for v in bundle.views}
    orders = views["orders"]
    assert orders.source_table == "Orders"
    assert orders.connection.dialect == "snowflake"

    by_name = {f.name: f for f in orders.fields}
    assert by_name["orderid"].kind == "dimension"
    assert by_name["orderid"].sql == "OrderID"  # bare column — Omni has no ${TABLE} token
    assert by_name["amount"].data_type == "number"
    assert by_name["createdat"].data_type == "timestamp"
    # calculated column never becomes a plain dimension
    assert "amounttax" not in by_name


def test_measures_deterministic_and_untranslatable():
    bundle = _model()
    orders = {v.name: v for v in bundle.views}["orders"]
    by_name = {f.name: f for f in orders.fields if f.kind == "measure"}

    assert by_name["total_amount"].sql == "Amount"
    assert by_name["total_amount"].aggregate == "sum"
    assert by_name["total_amount"].group_label == "Revenue"

    assert by_name["order_count"].sql is None
    assert by_name["order_count"].aggregate == "count"

    assert "avg_days_to_ship" not in by_name
    reasons = " ".join(n.reason for n in orders.untranslatable)
    assert "AI translation" in reasons


def test_calculated_column_flagged_not_emitted():
    bundle = _model()
    orders = {v.name: v for v in bundle.views}["orders"]
    reasons = " ".join(n.reason for n in orders.untranslatable)
    assert "calculated column" in reasons.lower()
    hints = [n.hint for n in orders.untranslatable]
    assert "Orders[Amount] * 1.1" in hints


def test_calculated_table_not_emitted_as_view():
    bundle = _model()
    names = {v.name for v in bundle.views}
    assert "date" not in names
    objects = " ".join(n.object for n in bundle.untranslatable)
    assert "calculated table" in objects.lower()


def test_relationship_becomes_topic_join():
    bundle = _model()
    (topic,) = bundle.topics
    assert topic.base_view == "orders"
    (join,) = topic.joins
    assert join.join_from_view == "orders"
    assert join.join_to_view == "customers"
    assert join.relationship_type == "many_to_one"
    assert join.on_sql == "${orders.customerid} = ${customers.customerid}"


def test_emits_valid_view_yaml():
    orders = {v.name: v for v in _model().views}["orders"]
    doc = yaml.safe_load(emit_view(orders))
    assert doc["table_name"] == "Orders"
    assert doc["measures"]["total_amount"]["aggregate_type"] == "sum"
    assert doc["measures"]["order_count"]["aggregate_type"] == "count"


def test_dax_translate_helper_directly():
    sql, agg, reason = translate_measure("SUM ( 'Orders'[Amount] )", home_table="Orders")
    assert (sql, agg, reason) == ("Amount", "sum", None)

    sql, agg, reason = translate_measure("COUNTROWS ( Orders )", home_table="Orders")
    assert (sql, agg, reason) == (None, "count", None)

    sql, agg, reason = translate_measure("DISTINCTCOUNT ( Orders[CustomerID] )", home_table="Orders")
    assert (sql, agg, reason) == ("CustomerID", "count_distinct", None)

    sql, agg, reason = translate_measure("SUM ( Customers[Amount] )", home_table="Orders")
    assert sql is None and agg is None and "another table" in reason

    sql, agg, reason = translate_measure("CALCULATE ( SUM ( Orders[Amount] ), Orders[Amount] > 0 )", home_table="Orders")
    assert sql is None and agg is None and reason


def test_direct_pbix_dispatch_uses_the_first_party_extractor(tmp_path, monkeypatch):
    pbix_path = tmp_path / "orders.pbix"
    with zipfile.ZipFile(pbix_path, "w"):
        pass

    instances = []

    class FakePBIXRay(FakePBIXModel):
        def __init__(self, path):
            assert path == str(pbix_path)
            super().__init__(schema=pd.DataFrame([
                {"TableName": "Orders", "ColumnName": "OrderID", "PandasDataType": "Int64"},
            ]))
            self.closed = False
            instances.append(self)

        def close(self):
            self.closed = True

    monkeypatch.setitem(sys.modules, "pbixray", types.SimpleNamespace(PBIXRay=FakePBIXRay))
    extractor = PowerBIExtractor()
    source = FileInput(paths=[pbix_path])

    assert extractor.detect(source) is True
    bundle = extractor.extract(source, ExtractCtx())

    assert bundle.source == "powerbi"
    assert [view.name for view in bundle.model.views] == ["orders"]
    assert bundle.provenance.source_artifact == str(pbix_path)
    assert instances and instances[0].closed is True

"""Programmatic source → Omni connection mapping."""

from __future__ import annotations

from omni_migrator.core.connection_map import (
    SourceConnection,
    apply_mapping,
    collect_source_connections,
    suggest_mapping,
)
from omni_migrator.ir.schema import ConnectionRef, ModelIR, ViewIR

CONNS = [
    {"id": "c1", "name": "Production Snowflake", "dialect": "snowflake", "database": "ANALYTICS", "defaultSchema": "PUBLIC"},
    {"id": "c2", "name": "Dev Snowflake", "dialect": "snowflake", "database": "DEV", "defaultSchema": "STAGING"},
    {"id": "c3", "name": "Warehouse", "dialect": "bigquery", "database": "proj", "defaultSchema": "ds"},
]


def test_single_dialect_match_is_automatic():
    m = suggest_mapping([SourceConnection(name="bq", dialect="bigquery")], CONNS)
    match = m["bq"]
    assert match.omni_connection_id == "c3"
    assert match.confidence == "dialect"


def test_name_match_disambiguates_multiple():
    m = suggest_mapping([SourceConnection(name="Production Snowflake", dialect="snowflake")], CONNS)
    match = m["Production Snowflake"]
    assert match.omni_connection_id == "c1"
    assert match.confidence == "exact"


def test_ambiguous_when_no_clear_winner():
    m = suggest_mapping([SourceConnection(name="snowflake", dialect="snowflake")], CONNS)
    match = m["snowflake"]
    assert match.omni_connection_id in {"c1", "c2"}
    assert match.confidence in {"ambiguous", "exact"}


def test_no_dialect_match_is_blocker():
    m = suggest_mapping([SourceConnection(name="pg", dialect="postgres")], CONNS)
    assert m["pg"].omni_connection_id is None
    assert m["pg"].confidence == "none"


def test_override_wins():
    m = suggest_mapping(
        [SourceConnection(name="snowflake", dialect="snowflake")], CONNS,
        overrides={"snowflake": "c2"},
    )
    assert m["snowflake"].omni_connection_id == "c2"
    assert m["snowflake"].confidence == "exact"


def test_apply_stamps_id_and_fills_schema():
    model = ModelIR(
        views=[
            ViewIR(
                name="orders", source_table="ORDERS", schema_name=None,
                connection=ConnectionRef(source_connection_name="bq", dialect="bigquery"),
            )
        ]
    )
    srcs = collect_source_connections(model)
    mapping = suggest_mapping(srcs, CONNS)
    notes = apply_mapping(model, mapping)
    assert model.views[0].connection.omni_connection_id == "c3"
    assert model.views[0].schema_name == "ds"  # filled from defaultSchema
    assert all(n.severity != "blocker" for n in notes)


def test_apply_stamps_database():
    """The matched Omni connection's `database` (e.g. "ecomm") must land on the view so
    `view_path`/`emit_view` can build the real `{database}.{schema}/{name}.view` path and
    `catalog:` key — verified live 2026-07-09 that a bare `{schema}/{name}.view` write creates
    a stray duplicate file instead of updating the real schema-synced one."""
    model = ModelIR(
        views=[
            ViewIR(
                name="orders", source_table="ORDERS", schema_name=None,
                connection=ConnectionRef(source_connection_name="bq", dialect="bigquery"),
            )
        ]
    )
    mapping = suggest_mapping(collect_source_connections(model), CONNS)
    apply_mapping(model, mapping)
    assert model.views[0].connection.database == "proj"


def test_apply_blocks_unmapped():
    # mysql is a valid IR dialect but absent from CONNS -> no match
    model = ModelIR(
        views=[ViewIR(name="x", connection=ConnectionRef(dialect="mysql"))]
    )
    mapping = suggest_mapping(collect_source_connections(model), CONNS)
    notes = apply_mapping(model, mapping)
    assert any(n.severity == "blocker" for n in notes)
    assert model.views[0].connection.omni_connection_id is None
    # attached to the view directly, not just returned — otherwise it never reaches the
    # per-view AI seed prompt or the ai_policy="notes" routing decision
    assert any(n.severity == "blocker" for n in model.views[0].untranslatable)


def test_apply_does_not_stamp_an_ambiguous_suggestion():
    model = ModelIR(
        views=[
            ViewIR(
                name="orders",
                connection=ConnectionRef(source_connection_name="unrelated", dialect="snowflake"),
            )
        ]
    )
    mapping = suggest_mapping(collect_source_connections(model), CONNS)
    assert mapping["unrelated"].confidence == "ambiguous"

    notes = apply_mapping(model, mapping)

    assert model.views[0].connection.omni_connection_id is None
    assert any(note.severity == "blocker" for note in notes)
    assert "Confirm a destination connection" in notes[0].reason


def test_override_can_confirm_a_cross_dialect_destination():
    source = SourceConnection(name="warehouse", dialect="snowflake")
    mapping = suggest_mapping([source], CONNS, overrides={"warehouse": "c3"})

    assert mapping["warehouse"].omni_connection_id == "c3"
    assert mapping["warehouse"].confidence == "exact"
    assert "override" in mapping["warehouse"].reason.lower()
    assert "snowflake" in mapping["warehouse"].reason
    assert "bigquery" in mapping["warehouse"].reason

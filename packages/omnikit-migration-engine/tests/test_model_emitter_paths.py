"""`view_path`/`emit_view` catalog handling — added alongside the connection-mapping fix
(2026-07-09): a view's real Omni file path is `{database}.{schema}/{name}.view`, not just
`{schema}/{name}.view`, once the Map stage has resolved the connection's database/catalog.
Verified live against test.thundersalmon.com: the connection had `database: "ecomm"` and
`alwaysScopeViewNames: true`, and its schema-synced views lived at `ecomm.public/<name>.view`
with `catalog: ecomm` in the YAML body — a bare `public/<name>.view` write (what this code
produced before) landed as a stray, wrongly-named second file rather than updating the real one."""

from __future__ import annotations

import yaml

from omni_migrator.deterministic.model_emitter import emit_model, emit_view, view_path
from omni_migrator.ir.schema import ConnectionRef, JoinIR, ModelIR, TopicIR, ViewIR


def test_view_path_includes_database_when_known():
    view = ViewIR(
        name="order_items", source_table="order_items", schema_name="public",
        connection=ConnectionRef(database="ecomm"),
    )
    assert view_path(view) == "ecomm.public/order_items.view"


def test_view_path_falls_back_to_schema_only_without_database():
    view = ViewIR(name="order_items", source_table="order_items", schema_name="public")
    assert view_path(view) == "public/order_items.view"


def test_emit_view_includes_catalog_key_when_database_known():
    view = ViewIR(
        name="order_items", source_table="order_items", schema_name="public",
        connection=ConnectionRef(database="ecomm"),
    )
    out = yaml.safe_load(emit_view(view))
    assert out["catalog"] == "ecomm"
    assert out["schema"] == "public"


def test_emit_view_omits_catalog_key_without_database():
    view = ViewIR(name="order_items", source_table="order_items", schema_name="public")
    out = yaml.safe_load(emit_view(view))
    assert "catalog" not in out


def _ecomm_model():
    conn = ConnectionRef(database="ecomm")
    order_items = ViewIR(name="order_items", source_table="order_items", schema_name="public", connection=conn)
    inventory_items = ViewIR(
        name="inventory_items", source_table="inventory_items", schema_name="public", connection=conn
    )
    topic = TopicIR(
        name="order_items",
        base_view="order_items",
        joins=[
            JoinIR(
                join_from_view="order_items",
                join_to_view="inventory_items",
                on_sql="${order_items.inventory_item_id} = ${inventory_items.id}",
            )
        ],
    )
    return ModelIR(views=[order_items, inventory_items], topics=[topic])


def test_relationships_reference_scoped_view_names_not_bare_ir_names():
    """Live-verified bug (2026-07-10): a relationships/topic file that references a view by its
    bare IR name (`order_items`) instead of Omni's actual scoped name (`ecomm_public__order_items`,
    when the connection has a database/catalog) produces a live validation warning — "No such view
    'order_items'. Did you mean 'ecomm_public__order_items'?" — every AI-refine call that happened
    to touch one of these files had to correct it by hand."""
    files = emit_model(_ecomm_model())
    rels = yaml.safe_load(files["relationships"])
    (rel,) = rels
    assert rel["join_from_view"] == "ecomm_public__order_items"
    assert rel["join_to_view"] == "ecomm_public__inventory_items"
    assert rel["on_sql"] == "${ecomm_public__order_items.inventory_item_id} = ${ecomm_public__inventory_items.id}"


def test_topic_references_scoped_view_names_not_bare_ir_names():
    files = emit_model(_ecomm_model())
    topic = yaml.safe_load(files["order_items.topic"])
    assert topic["base_view"] == "ecomm_public__order_items"
    assert list(topic["joins"]) == ["ecomm_public__inventory_items"]


def test_relationships_and_topic_use_bare_names_without_database():
    conn = ConnectionRef()
    order_items = ViewIR(name="order_items", source_table="order_items", schema_name="public", connection=conn)
    inventory_items = ViewIR(
        name="inventory_items", source_table="inventory_items", schema_name="public", connection=conn
    )
    topic = TopicIR(
        name="order_items",
        base_view="order_items",
        joins=[
            JoinIR(
                join_from_view="order_items",
                join_to_view="inventory_items",
                on_sql="${order_items.inventory_item_id} = ${inventory_items.id}",
            )
        ],
    )
    files = emit_model(ModelIR(views=[order_items, inventory_items], topics=[topic]))
    rels = yaml.safe_load(files["relationships"])
    (rel,) = rels
    assert rel["join_from_view"] == "order_items"
    topic_out = yaml.safe_load(files["order_items.topic"])
    assert topic_out["base_view"] == "order_items"

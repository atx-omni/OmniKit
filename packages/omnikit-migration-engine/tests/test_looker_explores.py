"""Looker explore -> Omni topic + relationships (deterministic, Appendix A.4)."""

from __future__ import annotations

from pathlib import Path

import yaml

from omni_migrator.core.contracts import ExtractCtx, FileInput
from omni_migrator.deterministic.model_emitter import emit_model, emit_relationships, emit_topic
from omni_migrator.extractors.looker.extractor import LookerExtractor

FIXTURE = Path(__file__).parent / "fixtures" / "order_items.model.lkml"


def _model():
    bundle = LookerExtractor().extract(FileInput(paths=[FIXTURE]), ExtractCtx())
    return bundle.model


def test_explore_becomes_topic_with_joins():
    model = _model()
    assert {v.name for v in model.views} == {"order_items", "orders", "users"}
    (topic,) = model.topics
    assert topic.name == "order_items"
    assert topic.base_view == "order_items"
    assert topic.label == "Order Items"

    joins = {j.join_to_view: j for j in topic.joins}
    assert set(joins) == {"orders", "users"}

    # sql_on join
    assert joins["orders"].join_from_view == "order_items"
    assert joins["orders"].join_type == "always_left"
    assert joins["orders"].relationship_type == "many_to_one"
    assert joins["orders"].on_sql == "${order_items.order_id} = ${orders.id}"

    # foreign_key join -> derived on_sql against the joined view's primary key (users.id)
    assert joins["users"].on_sql == "${order_items.user_id} = ${users.id}"


def test_topic_and_relationships_yaml():
    model = _model()
    topic_yaml = yaml.safe_load(emit_topic(model.topics[0]))
    assert "name" not in topic_yaml
    assert topic_yaml["base_view"] == "order_items"
    assert topic_yaml["joins"] == {"orders": {}, "users": {}}

    rels = yaml.safe_load(emit_relationships(model))
    by_to = {r["join_to_view"]: r for r in rels}
    assert by_to["orders"]["join_from_view"] == "order_items"
    assert by_to["orders"]["join_type"] == "always_left"
    assert by_to["orders"]["relationship_type"] == "many_to_one"
    assert by_to["orders"]["on_sql"] == "${order_items.order_id} = ${orders.id}"
    assert "users" in by_to


def test_emit_model_includes_topic_and_relationship_files():
    files = emit_model(_model())
    assert "order_items.topic" in files
    assert "relationships" in files
    assert "analytics/order_items.view" in files

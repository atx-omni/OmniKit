"""Versioned JSON Schema for the OmniKit migration bridge result."""

from __future__ import annotations

from typing import Any

from omni_migrator.bridge import BridgeExtractResult


CONTRACT_SCHEMA_ID = (
    "https://github.com/exploreomni/omni-migrator/contracts/"
    "omnikit.migration.bundle.v1.schema.json"
)

IDENTITY_DEFINITIONS = {
    "DashboardIR",
    "FieldIR",
    "FilterIR",
    "JoinIR",
    "QueryIR",
    "TileIR",
    "TopicIR",
    "ViewIR",
}


def _public_identity_schema(schema: dict[str, Any]) -> None:
    definitions = schema.get("$defs", {})
    for name in IDENTITY_DEFINITIONS:
        definition = definitions.get(name)
        if not isinstance(definition, dict):
            continue
        properties = definition.get("properties", {})
        definition["required"] = sorted(set(definition.get("required", [])) | {
            "source_id", "source_locator", "evidence",
        })
        properties["source_id"] = {"type": "string", "minLength": 1}
        properties["source_locator"] = {"type": "string", "minLength": 1}
        if isinstance(properties.get("evidence"), dict):
            properties["evidence"]["minItems"] = 1

    evidence = definitions.get("SourceEvidence")
    if isinstance(evidence, dict):
        properties = evidence.get("properties", {})
        evidence["required"] = sorted(set(evidence.get("required", [])) | {
            "locator", "content_sha256", "role",
        })
        properties["locator"] = {"type": "string", "minLength": 1}
        properties["content_sha256"] = {
            "type": "string", "pattern": "^[A-Fa-f0-9]{64}$",
        }


def build_contract_schema() -> dict[str, Any]:
    """Return the deterministic Draft 2020-12 schema for the released result contract."""
    schema = BridgeExtractResult.model_json_schema(mode="serialization")
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = CONTRACT_SCHEMA_ID
    schema["title"] = "OmniKit Migration Bundle V1"
    _public_identity_schema(schema)
    return schema

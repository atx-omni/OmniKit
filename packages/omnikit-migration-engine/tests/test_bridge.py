import hashlib
import json
import zipfile
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from omni_migrator.bridge import (
    BRIDGE_SCHEMA_VERSION,
    MAX_LOOKML_ARTIFACT_BYTES,
    BridgeExtractRequest,
    BridgeExtractResult,
    BridgeTargetConnection,
    bridge_capabilities,
    execute_bridge_extract,
)
from omni_migrator.contract_schema import build_contract_schema

FIXTURES = Path(__file__).parent / "fixtures"
CONTRACT_FIXTURE = Path(__file__).parent.parent / "contracts" / "fixtures" / "omnikit.migration.bundle.v1.valid.json"
CONTRACT_SCHEMA = Path(__file__).parent.parent / "contracts" / "omnikit.migration.bundle.v1.schema.json"
SHARED_FIXTURE_SHA256 = "650db951d5304c11cae92f10a2da1deccc2359905de4c27c5eb676c0b6ee829e"


def request_for(name: str) -> BridgeExtractRequest:
    return BridgeExtractRequest.model_validate({
        "schema_version": BRIDGE_SCHEMA_VERSION,
        "request_id": "bridge-test",
        "source": "looker",
        "mode": "manual",
        "artifact_root": str(FIXTURES),
        "artifacts": [{"path": name, "name": name}],
    })


def test_bridge_extracts_looker_and_emits_review_suggestions():
    result = execute_bridge_extract(request_for("orders.view.lkml"))

    assert result.schema_version == "omnikit.migration.bundle.v1"
    assert result.engine["name"] == "omni-migrator"
    assert result.diagnostics.view_count == 1
    assert result.provenance["source_artifacts"] == ["orders.view.lkml"]
    fingerprint = result.provenance["source_artifact_fingerprints"][0]
    assert fingerprint["name"] == "orders.view.lkml"
    assert len(fingerprint["sha256"]) == 64
    assert fingerprint["size_bytes"] > 0
    assert result.model_suggestions
    assert all(item.sha256 and item.content for item in result.model_suggestions)
    assert result.bundle.model.views[0].source_id
    assert result.bundle.model.views[0].fields[0].source_id
    assert result.bundle.model.views[0].evidence[0].artifact_sha256 == fingerprint["sha256"]


def test_professional_looker_bridge_separates_baseline_yaml_from_review_required_fragments():
    request = BridgeExtractRequest.model_validate({
        "schema_version": BRIDGE_SCHEMA_VERSION,
        "request_id": "professional-looker",
        "source": "looker",
        "mode": "manual",
        "artifact_root": str(FIXTURES),
        "artifacts": [
            {"path": "looker_professional.view.lkml", "name": "looker_professional.view.lkml"},
            {"path": "looker_professional.model.lkml", "name": "looker_professional.model.lkml"},
        ],
    })
    result = execute_bridge_extract(request)
    requirements = {item.object_type: item for item in result.bundle.model.requirements}

    assert requirements["parameter"].source_id
    assert "segment_mode" in requirements["parameter"].config["proposed_yaml"]
    assert requirements["filtered_measure"].support_outcome == "decision_required"
    assert requirements["derived_table"].support_outcome == "manual"
    view_suggestion = next(item for item in result.model_suggestions if item.path.endswith("example_orders.view"))
    topic_suggestion = next(item for item in result.model_suggestions if item.path == "example_orders.topic")
    assert "segment_mode" not in view_suggestion.content
    assert "always_where_filters" not in topic_suggestion.content
    assert requirements["parameter"].source_id in view_suggestion.source_ids
    assert requirements["access_filter"].source_id in topic_suggestion.source_ids


def test_shared_contract_fixture_is_content_addressed_and_valid():
    content = CONTRACT_FIXTURE.read_bytes()
    assert hashlib.sha256(content).hexdigest() == SHARED_FIXTURE_SHA256
    parsed = BridgeExtractResult.model_validate_json(content)
    assert parsed.bundle.model.views[0].source_id == "looker:view:111111111111111111111111"


def test_committed_json_schema_matches_pydantic_and_accepts_the_shared_fixture():
    committed = json.loads(CONTRACT_SCHEMA.read_text())
    generated = build_contract_schema()
    assert committed == generated
    Draft202012Validator.check_schema(committed)
    Draft202012Validator(committed).validate(json.loads(CONTRACT_FIXTURE.read_text()))


def test_source_ids_are_stable_when_view_order_changes():
    first = execute_bridge_extract(request_for("orders.view.lkml"))
    first_ids = {view.name: view.source_id for view in first.bundle.model.views}
    first.bundle.model.views.reverse()
    from omni_migrator.ir.identity import enrich_bundle_identity

    enrich_bundle_identity(first.bundle, first.provenance["source_artifact_fingerprints"])
    assert {view.name: view.source_id for view in first.bundle.model.views} == first_ids


def test_bridge_rejects_unknown_contract_versions():
    payload = request_for("orders.view.lkml").model_dump()
    payload["schema_version"] = "future.version"

    with pytest.raises(ValidationError):
        BridgeExtractRequest.model_validate(payload)


def test_bridge_rejects_artifacts_outside_the_declared_root(tmp_path: Path):
    outside = tmp_path.parent / "outside.lkml"
    outside.write_text("view: outside {}")
    request = BridgeExtractRequest.model_validate({
        "request_id": "traversal-test",
        "source": "looker",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": "../outside.lkml"}],
    })

    with pytest.raises(ValueError, match="inside artifact_root"):
        execute_bridge_extract(request)


def test_capability_manifest_has_no_write_authority():
    manifest = bridge_capabilities()

    assert manifest["write_authority"] is False
    assert manifest["operations"] == ["extract", "capabilities", "conformance"]
    assert manifest["schema_version"] == "omnikit.migration.bridge.v1"
    assert manifest["result_schema_version"] == "omnikit.migration.bundle.v1"
    assert manifest["supported_result_schema_versions"] == ["omnikit.migration.bundle.v1"]
    assert manifest["compatibility_policy"]["unknown_versions"] == "reject"
    assert manifest["compatibility_policy"]["previous"] is None
    assert tuple(int(item) for item in manifest["runtime"]["python_version"].split(".")[:2]) >= (3, 11)
    assert manifest["replay_policy"]["in_flight_duplicate"] == "reject"
    assert manifest["connection_mapping"]["requires_confirmation"] == ["ambiguous", "none"]
    assert manifest["sources"]["looker"]["artifact_coverage"]["relationships"] == "full"
    assert manifest["sources"]["sigma"]["artifact_coverage"]["layout"] == "unsupported"
    assert manifest["sources"]["powerbi"]["artifact_coverage"]["permissions"] == "unsupported"
    assert "omni-api" not in json.dumps(manifest)


def test_bridge_rejects_archive_path_traversal(tmp_path: Path):
    archive = tmp_path / "unsafe.twbx"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("../outside.twb", "<workbook />")
    request = BridgeExtractRequest.model_validate({
        "request_id": "archive-traversal-test",
        "source": "tableau",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": archive.name}],
    })

    with pytest.raises(ValueError, match="unsafe path"):
        execute_bridge_extract(request)


def test_bridge_rejects_symbolic_link_artifacts(tmp_path: Path):
    target = tmp_path / "target.lkml"
    target.write_text("view: target {}")
    link = tmp_path / "link.lkml"
    link.symlink_to(target)
    request = BridgeExtractRequest.model_validate({
        "request_id": "symlink-test",
        "source": "looker",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": link.name}],
    })

    with pytest.raises(ValueError, match="symbolic-link"):
        execute_bridge_extract(request)


def test_bridge_rejects_duplicate_archive_members(tmp_path: Path):
    archive = tmp_path / "duplicate.twbx"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("workbook.twb", "<workbook />")
        output.writestr("workbook.twb", "<workbook><dashboard /></workbook>")
    request = BridgeExtractRequest.model_validate({
        "request_id": "duplicate-archive-test",
        "source": "tableau",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": archive.name}],
    })

    with pytest.raises(ValueError, match="duplicate path"):
        execute_bridge_extract(request)


def test_bridge_rejects_high_ratio_archives(tmp_path: Path):
    archive = tmp_path / "ratio.twbx"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        output.writestr("workbook.twb", b"0" * 2_000_000)
    request = BridgeExtractRequest.model_validate({
        "request_id": "ratio-test",
        "source": "tableau",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": archive.name}],
    })

    with pytest.raises(ValueError, match="expansion ratio"):
        execute_bridge_extract(request)


def test_bridge_rejects_oversized_lookml_before_parser_allocation(tmp_path: Path):
    artifact = tmp_path / "oversized.view.lkml"
    with artifact.open("wb") as output:
        output.seek(MAX_LOOKML_ARTIFACT_BYTES)
        output.write(b"x")
    request = BridgeExtractRequest.model_validate({
        "request_id": "oversized-lookml-test",
        "source": "looker",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": artifact.name}],
    })

    with pytest.raises(ValueError, match="LookML artifact exceeds"):
        execute_bridge_extract(request)


def test_bridge_rejects_malformed_metabase_json(tmp_path: Path):
    artifact = tmp_path / "malformed-metabase.json"
    artifact.write_text('{"dashboards": [}')
    request = BridgeExtractRequest.model_validate({
        "request_id": "malformed-json-test",
        "source": "metabase",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": artifact.name}],
    })

    with pytest.raises(json.JSONDecodeError):
        execute_bridge_extract(request)


def test_bridge_rejects_tableau_xml_entities(tmp_path: Path):
    artifact = tmp_path / "entity-workbook.twb"
    artifact.write_text(
        '<!DOCTYPE workbook [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
        '<workbook><dashboard name="&xxe;" /></workbook>'
    )
    request = BridgeExtractRequest.model_validate({
        "request_id": "tableau-entity-test",
        "source": "tableau",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": artifact.name}],
    })

    with pytest.raises(ValueError, match="declarations and entities are not accepted"):
        execute_bridge_extract(request)


def test_bridge_reports_the_rulebook_version():
    result = execute_bridge_extract(request_for("orders.view.lkml"))

    assert result.diagnostics.rulebook_version == "v2"
    assert len(result.diagnostics.rulebook_sha256) == 64
    assert all(item.rulebook_sha256 == result.diagnostics.rulebook_sha256 for item in result.model_suggestions)
    assert all(item.source_ids and item.evidence for item in result.model_suggestions)


def test_bridge_rejects_unknown_rulebooks():
    request = request_for("orders.view.lkml")
    request.rulebook_version = "not-a-rulebook"

    with pytest.raises(ValueError, match="unknown or empty rulebook"):
        execute_bridge_extract(request)


def test_bridge_accepts_a_manual_metabase_snapshot(tmp_path: Path):
    snapshot = tmp_path / "metabase-snapshot.json"
    snapshot.write_text(json.dumps({
        "databases": [], "tables": [], "segments": [], "metrics": [],
        "cards": [], "dashboards": [],
    }))
    request = BridgeExtractRequest.model_validate({
        "request_id": "metabase-manual-test",
        "source": "metabase",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": snapshot.name, "name": snapshot.name}],
    })

    result = execute_bridge_extract(request)

    assert result.source == "metabase"
    assert result.mode == "manual"
    assert result.diagnostics.dashboard_count == 0
    assert result.provenance["source_artifact_fingerprints"][0]["name"] == snapshot.name


def test_bridge_returns_and_applies_a_confirmed_connection_override():
    request = request_for("order_items.model.lkml")
    request.target_connections = [
        BridgeTargetConnection(
            id="target-connection",
            name="Omni Warehouse",
            dialect="snowflake",
            database="ANALYTICS",
            default_schema="PUBLIC",
        ),
        BridgeTargetConnection(
            id="cross-dialect-connection",
            name="Postgres Review",
            dialect="postgres",
        ),
    ]
    request.connection_overrides = {"ecommerce": "target-connection"}

    result = execute_bridge_extract(request)

    assert len(result.connection_mappings) == 1
    mapping = result.connection_mappings[0]
    assert mapping.source_key == "ecommerce"
    assert mapping.target_connection_id == "target-connection"
    assert mapping.confirmed is True
    assert [candidate.id for candidate in mapping.candidates] == [
        "target-connection", "cross-dialect-connection"
    ]
    assert all(
        view.connection.omni_connection_id == "target-connection"
        for view in result.bundle.model.views
    )
    assert all(view.connection.database == "ANALYTICS" for view in result.bundle.model.views)


def test_bridge_leaves_an_ambiguous_connection_unapplied(tmp_path: Path):
    datasource = tmp_path / "orders.tds"
    datasource.write_text((FIXTURES / "orders.tds").read_text())
    request = BridgeExtractRequest.model_validate({
        "request_id": "ambiguous-connection-test",
        "source": "tableau",
        "mode": "manual",
        "artifact_root": str(tmp_path),
        "artifacts": [{"path": datasource.name}],
        "target_connections": [
            {"id": "one", "name": "Warehouse One", "dialect": "snowflake"},
            {"id": "two", "name": "Warehouse Two", "dialect": "snowflake"},
        ],
    })

    result = execute_bridge_extract(request)

    assert result.connection_mappings[0].confidence == "ambiguous"
    assert result.connection_mappings[0].candidate_ids == ["one", "two"]
    assert result.connection_mappings[0].confirmed is False
    assert all(view.connection.omni_connection_id is None for view in result.bundle.model.views)
    assert any(
        note.severity == "blocker"
        for view in result.bundle.model.views
        for note in view.untranslatable
    )

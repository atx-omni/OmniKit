import json
from pathlib import Path

from omni_migrator.conformance import (
    CONFORMANCE_SOURCES,
    build_conformance_manifest,
    run_conformance,
)


def test_all_source_contracts_pass_and_classify_fidelity():
    result = run_conformance()

    assert result["passed"] is True
    assert set(result["sources"]) == set(CONFORMANCE_SOURCES)
    for source, evidence in result["sources"].items():
        assert evidence["passed"] is True, source
        assert evidence["manifest_sha256"] == evidence["expected_sha256"]
        classes = evidence["coverage"]["fidelity_classes"]
        assert set(classes) == {"full", "partial", "unsupported"}


def test_tableau_and_sigma_limits_cannot_appear_as_full_fidelity():
    tableau = build_conformance_manifest("tableau")
    sigma = build_conformance_manifest("sigma")

    assert "relationships" in tableau["coverage"]["fidelity_classes"]["partial"]
    assert "permissions" in tableau["coverage"]["fidelity_classes"]["unsupported"]
    assert "layout" in sigma["coverage"]["fidelity_classes"]["unsupported"]
    assert sigma["coverage"]["fidelity_classes"]["full"] == []


def test_conformance_detects_contract_drift(tmp_path: Path):
    source = "looker"
    contract = build_conformance_manifest(source)
    contract["objects"]["views"][0]["fields"] = []
    (tmp_path / f"{source}.json").write_text(json.dumps(contract))

    result = run_conformance(source, contract_root=tmp_path)

    assert result["passed"] is False
    assert result["sources"][source]["passed"] is False
    assert any("fields" in item for item in result["sources"][source]["errors"])


def test_tableau_conformance_has_no_reference_only_phantom_view():
    manifest = build_conformance_manifest("tableau")

    assert [item["name"] for item in manifest["objects"]["views"]] == ["customers", "orders"]
    customer_fields = manifest["objects"]["views"][0]["fields"]
    assert any(item["name"] == "customer_name" for item in customer_fields)

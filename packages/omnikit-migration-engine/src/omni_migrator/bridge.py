"""Restricted JSON bridge for embedding omni-migrator in trusted local control planes.

The bridge can acquire/parse source artifacts and emit deterministic suggestions. It has
no loader, Omni client, branch, write, or merge capability. Callers remain responsible for
credential custody, human review, target writes, and audit policy.
"""

from __future__ import annotations

import hashlib
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from omni_migrator import __version__
from omni_migrator.core.contracts import ApiInput, ExtractCtx, FileInput
from omni_migrator.core.connection_map import apply_mapping, collect_source_connections, suggest_mapping
from omni_migrator.core.registry import get_extractor
from omni_migrator.deterministic.model_emitter import emit_model
from omni_migrator.deterministic.model_emitter import topic_path, view_path
from omni_migrator.ai.rulebook import load_rulebook
from omni_migrator.ir.schema import MigrationBundle, SourceEvidence, UntranslatableNote
from omni_migrator.ir.identity import assert_bundle_identity, enrich_bundle_identity

BRIDGE_SCHEMA_VERSION = "omnikit.migration.bridge.v1"
RESULT_SCHEMA_VERSION = "omnikit.migration.bundle.v1"
MAX_ARTIFACTS = 2_000
MAX_ARTIFACT_BYTES = 1_000_000_000
MAX_LOOKML_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 50_000
MAX_ARCHIVE_EXPANDED_BYTES = 2_000_000_000
MAX_ARCHIVE_EXPANSION_RATIO = 500

BridgeSource = Literal["looker", "powerbi", "power_bi", "tableau", "metabase", "sigma"]
BridgeMode = Literal["manual", "api"]


class BridgeArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    name: str | None = None
    sha256: str | None = None

    @field_validator("path")
    @classmethod
    def non_empty_path(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("artifact path must not be empty")
        return value


class BridgeApiConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str
    auth: dict[str, Any] = Field(default_factory=dict)


class BridgeTargetConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    dialect: str
    database: str | None = None
    default_schema: str | None = None

    @field_validator("id", "name")
    @classmethod
    def non_empty_connection_identity(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("target connection id and name must not be empty")
        return value


class BridgeExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["omnikit.migration.bridge.v1"] = BRIDGE_SCHEMA_VERSION
    request_id: str
    source: BridgeSource
    mode: BridgeMode
    artifact_root: str | None = None
    artifacts: list[BridgeArtifact] = Field(default_factory=list)
    connection: BridgeApiConnection | None = None
    default_schema: str | None = None
    scope: dict[str, Any] = Field(default_factory=dict)
    include_model_suggestions: bool = True
    rulebook_version: str = "v2"
    target_connections: list[BridgeTargetConnection] = Field(default_factory=list)
    connection_overrides: dict[str, str] = Field(default_factory=dict)

    @field_validator("request_id")
    @classmethod
    def non_empty_request_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("request_id must not be empty")
        return value

    @model_validator(mode="after")
    def validate_mode(self) -> "BridgeExtractRequest":
        if self.mode == "manual" and (not self.artifact_root or not self.artifacts):
            raise ValueError("manual extraction requires artifact_root and at least one artifact")
        if self.mode == "api" and self.connection is None:
            raise ValueError("API extraction requires connection")
        if len(self.artifacts) > MAX_ARTIFACTS:
            raise ValueError(f"manual extraction accepts at most {MAX_ARTIFACTS} artifacts")
        return self


class BridgeModelSuggestion(BaseModel):
    path: str
    content: str
    sha256: str
    parser_version: str
    rulebook_version: str
    rulebook_sha256: str
    confidence: float = Field(ge=0, le=1)
    severity: Literal["info", "warning", "blocker"]
    source_ids: list[str] = Field(default_factory=list)
    evidence: list[SourceEvidence] = Field(default_factory=list)


class BridgeDiagnostics(BaseModel):
    view_count: int
    topic_count: int
    dashboard_count: int
    field_count: int
    untranslatable_count: int
    source_artifact_count: int
    limitations: list[str]
    rulebook_version: str
    rulebook_sha256: str
    acquisition_contract_version: str | None = None
    saved_look_coverage: str | None = None
    dependency_closure_status: str | None = None
    source_query_validation_status: str | None = None


class BridgeConnectionMapping(BaseModel):
    source_key: str
    source_name: str | None = None
    source_dialect: str
    source_schema: str | None = None
    target_connection_id: str | None = None
    target_connection_name: str | None = None
    target_dialect: str | None = None
    target_database: str | None = None
    target_default_schema: str | None = None
    confidence: Literal["exact", "dialect", "ambiguous", "none"]
    reason: str
    candidate_ids: list[str] = Field(default_factory=list)
    candidates: list[BridgeTargetConnection] = Field(default_factory=list)
    confirmed: bool = False


class BridgeExtractResult(BaseModel):
    schema_version: Literal["omnikit.migration.bundle.v1"] = RESULT_SCHEMA_VERSION
    request_id: str
    engine: dict[str, str]
    source: str
    mode: BridgeMode
    provenance: dict[str, Any]
    capability_coverage: dict[str, Any]
    bundle: MigrationBundle
    model_suggestions: list[BridgeModelSuggestion]
    connection_mappings: list[BridgeConnectionMapping] = Field(default_factory=list)
    diagnostics: BridgeDiagnostics

    @model_validator(mode="after")
    def validate_public_identity(self) -> "BridgeExtractResult":
        assert_bundle_identity(self.bundle)
        return self


CAPABILITIES: dict[str, dict[str, Any]] = {
    "looker": {
        "manual": True, "api": True, "semantic": "partial", "dashboards": "partial",
        "formats": ".model.lkml,.view.lkml,.dashboard.lookml",
        "artifact_coverage": {
            "models": "partial", "views": "full", "fields": "partial", "calculations": "partial",
            "relationships": "full", "topics": "full", "dashboards": "partial",
            "tiles": "partial", "filters": "partial", "layout": "partial",
            "permissions": "unsupported", "schedules": "unsupported",
        },
    },
    "powerbi": {
        "manual": True, "api": False, "semantic": "full", "dashboards": "partial",
        "formats": ".pbix",
        "artifact_coverage": {
            "models": "full", "views": "full", "fields": "full", "calculations": "partial",
            "relationships": "full", "topics": "partial", "dashboards": "partial",
            "tiles": "partial", "filters": "partial", "layout": "partial",
            # The current IR carries no principal/role assignments. Keep this explicit so
            # extraction success is never misreported as a security migration.
            "permissions": "unsupported", "schedules": "unsupported",
        },
    },
    "tableau": {
        "manual": True, "api": False, "semantic": "full", "dashboards": "partial",
        "formats": ".tds,.tdsx,.twb,.twbx",
        "artifact_coverage": {
            "models": "partial", "views": "full", "fields": "full", "calculations": "partial",
            "relationships": "partial", "topics": "partial", "dashboards": "partial",
            "tiles": "partial", "filters": "partial", "layout": "partial",
            "permissions": "unsupported", "schedules": "unsupported",
        },
    },
    "metabase": {
        "manual": True, "api": True, "semantic": "full", "dashboards": "full",
        "formats": "REST API snapshot JSON",
        "artifact_coverage": {
            "models": "partial", "views": "full", "fields": "full", "calculations": "partial",
            "relationships": "partial", "topics": "full", "dashboards": "full",
            "tiles": "full", "filters": "full", "layout": "full",
            "permissions": "unsupported", "schedules": "unsupported",
        },
    },
    "sigma": {
        "manual": False, "api": True, "semantic": "partial", "dashboards": "partial",
        "formats": "REST API snapshot",
        "artifact_coverage": {
            "models": "partial", "views": "partial", "fields": "partial", "calculations": "partial",
            "relationships": "partial", "topics": "partial", "dashboards": "partial",
            "tiles": "partial", "filters": "partial", "layout": "unsupported",
            "permissions": "unsupported", "schedules": "unsupported",
        },
    },
}

LIMITATIONS: dict[str, list[str]] = {
    "looker": ["Merged queries, Liquid behavior, and complete visualization fidelity require review."],
    "powerbi": ["Complex DAX, Power Query execution, security identity assignment, and custom visuals require review."],
    "tableau": ["LOD expressions, dashboard actions, and pixel-level formatting require review."],
    "metabase": ["Native SQL cards and unresolved ad-hoc aggregations require review."],
    "sigma": ["The public API does not expose reliable grid geometry; controls and layout require redesign review."],
}


def bridge_capabilities() -> dict[str, Any]:
    return {
        "schema_version": BRIDGE_SCHEMA_VERSION,
        "result_schema_version": RESULT_SCHEMA_VERSION,
        "supported_result_schema_versions": [RESULT_SCHEMA_VERSION],
        "compatibility_policy": {
            "current": RESULT_SCHEMA_VERSION,
            "previous": None,
            "unknown_versions": "reject",
            "deprecation": "add the next schema before removing the prior released schema",
        },
        "engine": {"name": "omni-migrator", "version": __version__},
        "runtime": {"python_version": ".".join(str(item) for item in sys.version_info[:3])},
        "operations": ["extract", "capabilities", "conformance"],
        "write_authority": False,
        "connection_mapping": {
            "mode": "advisory",
            "safe_auto_apply": ["exact", "dialect"],
            "requires_confirmation": ["ambiguous", "none"],
        },
        "replay_policy": {
            "in_flight_duplicate": "reject",
            "completed_retry": "allowed",
            "idempotency_key": "request_id_plus_sanitized_input_fingerprint",
        },
        "sources": CAPABILITIES,
    }


def _normalized_source(source: BridgeSource) -> str:
    return "powerbi" if source == "power_bi" else source


def _artifact_paths(request: BridgeExtractRequest) -> tuple[list[Path], list[str], list[dict[str, Any]]]:
    root = Path(request.artifact_root or "").expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("artifact_root must be a directory")

    paths: list[Path] = []
    names: list[str] = []
    fingerprints: list[dict[str, Any]] = []
    total_bytes = 0
    for artifact in request.artifacts:
        candidate_input = Path(artifact.path)
        candidate = (candidate_input if candidate_input.is_absolute() else root / candidate_input)
        if candidate.is_symlink():
            raise ValueError(f"symbolic-link artifacts are not accepted: {artifact.path}")
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ValueError(f"artifact must be a regular file inside artifact_root: {artifact.path}")
        artifact_bytes = resolved.stat().st_size
        if resolved.name.lower().endswith((".lkml", ".lookml")) and artifact_bytes > MAX_LOOKML_ARTIFACT_BYTES:
            raise ValueError(
                f"LookML artifact exceeds the {MAX_LOOKML_ARTIFACT_BYTES} byte parser limit: "
                f"{artifact.name or resolved.name}"
            )
        total_bytes += artifact_bytes
        if total_bytes > MAX_ARTIFACT_BYTES:
            raise ValueError(f"manual artifacts exceed the {MAX_ARTIFACT_BYTES} byte bridge limit")
        actual = hashlib.sha256(resolved.read_bytes()).hexdigest()
        if artifact.sha256:
            if actual.lower() != artifact.sha256.lower():
                raise ValueError(f"artifact checksum mismatch: {artifact.name or resolved.name}")
        _validate_archive(resolved)
        paths.append(resolved)
        name = artifact.name or resolved.name
        names.append(name)
        fingerprints.append({"name": name, "sha256": actual, "size_bytes": artifact_bytes})
    return paths, names, fingerprints


def _validate_archive(path: Path) -> None:
    if path.suffix.lower() not in {".pbix", ".twbx", ".tdsx", ".zip"}:
        return
    if not zipfile.is_zipfile(path):
        raise ValueError(f"expected a valid ZIP-based source artifact: {path.name}")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            raise ValueError(f"archive contains more than {MAX_ARCHIVE_ENTRIES} entries: {path.name}")
        expanded_bytes = 0
        compressed_bytes = 0
        normalized_members: set[str] = set()
        for entry in entries:
            member = PurePosixPath(entry.filename.replace("\\", "/"))
            normalized = member.as_posix()
            if "\x00" in entry.filename or member.is_absolute() or ".." in member.parts:
                raise ValueError(f"archive contains an unsafe path: {path.name}")
            if normalized in normalized_members:
                raise ValueError(f"archive contains a duplicate path: {path.name}")
            normalized_members.add(normalized)
            if entry.flag_bits & 0x1:
                raise ValueError(f"encrypted archive entries are not accepted: {path.name}")
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError(f"archive contains a symbolic link: {path.name}")
            expanded_bytes += entry.file_size
            compressed_bytes += entry.compress_size
            if expanded_bytes > MAX_ARCHIVE_EXPANDED_BYTES:
                raise ValueError(f"archive expands beyond the safe byte limit: {path.name}")
        if compressed_bytes > 0 and expanded_bytes / compressed_bytes > MAX_ARCHIVE_EXPANSION_RATIO:
            raise ValueError(f"archive expansion ratio exceeds the safe limit: {path.name}")


def _notes(bundle: MigrationBundle) -> list[UntranslatableNote]:
    notes = list(bundle.model.untranslatable)
    notes.extend(
        UntranslatableNote(
            object=requirement.name,
            reason=requirement.reason,
            severity="blocker" if requirement.support_outcome in {"manual", "unsupported"} else "warning",
            hint=requirement.target_file_hint,
        )
        for requirement in bundle.model.requirements
        if requirement.support_outcome != "automatic"
    )
    for view in bundle.model.views:
        notes.extend(view.untranslatable)
        for field in view.fields:
            notes.extend(field.untranslatable)
    for dashboard in bundle.dashboards:
        notes.extend(dashboard.untranslatable)
        for tile in dashboard.tiles:
            notes.extend(tile.untranslatable)
    return notes


def _severity(notes: list[UntranslatableNote]) -> Literal["info", "warning", "blocker"]:
    values = {note.severity for note in notes}
    if "blocker" in values:
        return "blocker"
    if "warning" in values:
        return "warning"
    return "info"


def _suggestion_provenance(
    bundle: MigrationBundle,
    path: str,
) -> tuple[list[str], list[SourceEvidence], list[UntranslatableNote]]:
    requirements = [
        requirement
        for requirement in bundle.model.requirements
        if requirement.target_file_hint
        and (path == requirement.target_file_hint or path.endswith(f"/{requirement.target_file_hint}"))
    ]
    requirement_notes = [
        UntranslatableNote(
            object=requirement.name,
            reason=requirement.reason,
            severity="blocker" if requirement.support_outcome in {"manual", "unsupported"} else "warning",
            hint=requirement.target_file_hint,
        )
        for requirement in requirements
        if requirement.support_outcome != "automatic"
    ]
    requirement_ids = [requirement.source_id for requirement in requirements if requirement.source_id]
    requirement_evidence = [item for requirement in requirements for item in requirement.evidence]
    if path == "relationships":
        joins = [join for topic in bundle.model.topics for join in topic.joins]
        return (
            [join.source_id for join in joins if join.source_id],
            [item for join in joins for item in join.evidence],
            [*bundle.model.untranslatable, *requirement_notes],
        )
    for view in bundle.model.views:
        if view_path(view) == path:
            notes = [*view.untranslatable, *(note for field in view.fields for note in field.untranslatable)]
            return (
                [item for item in [view.source_id, *(field.source_id for field in view.fields), *requirement_ids] if item],
                [*view.evidence, *(item for field in view.fields for item in field.evidence), *requirement_evidence],
                [*notes, *requirement_notes],
            )
    for topic in bundle.model.topics:
        if topic_path(topic) == path:
            return (
                [item for item in [topic.source_id, *(join.source_id for join in topic.joins), *requirement_ids] if item],
                [*topic.evidence, *(item for join in topic.joins for item in join.evidence), *requirement_evidence],
                [*bundle.model.untranslatable, *requirement_notes],
            )
    return [], [], list(bundle.model.untranslatable)


def execute_bridge_extract(request: BridgeExtractRequest) -> BridgeExtractResult:
    source = _normalized_source(request.source)
    capabilities = CAPABILITIES[source]
    if not bool(capabilities[request.mode]):
        raise ValueError(f"{source} does not support {request.mode} extraction through this bridge")

    rulebook = load_rulebook(source, request.rulebook_version)
    if not rulebook.strip():
        raise ValueError(f"unknown or empty rulebook '{request.rulebook_version}' for {source}")
    rulebook_sha256 = hashlib.sha256(rulebook.encode("utf-8")).hexdigest()

    extractor = get_extractor(source)
    source_names: list[str] = []
    source_fingerprints: list[dict[str, Any]] = []
    if request.mode == "manual":
        paths, source_names, source_fingerprints = _artifact_paths(request)
        extractor_input = FileInput(paths=paths)
    else:
        assert request.connection is not None
        extractor_input = ApiInput(base_url=request.connection.base_url, auth=request.connection.auth)

    bundle = extractor.extract(
        extractor_input,
        ExtractCtx(default_schema=request.default_schema, scope=request.scope),
    )
    bundle.provenance.source_artifact = ", ".join(source_names) if source_names else "API snapshot"
    enrich_bundle_identity(bundle, source_fingerprints)

    connection_mappings: list[BridgeConnectionMapping] = []
    if request.target_connections:
        target_connections = [
            {
                "id": item.id,
                "name": item.name,
                "dialect": item.dialect,
                "database": item.database,
                "defaultSchema": item.default_schema,
            }
            for item in request.target_connections
        ]
        target_by_id = {item["id"]: item for item in target_connections}
        mapping = suggest_mapping(
            collect_source_connections(bundle.model),
            target_connections,
            overrides=request.connection_overrides,
        )
        apply_mapping(bundle.model, mapping)
        for source_key, match in sorted(mapping.items()):
            target = target_by_id.get(match.omni_connection_id or "")
            connection_mappings.append(BridgeConnectionMapping(
                source_key=source_key,
                source_name=match.source.name,
                source_dialect=match.source.dialect,
                source_schema=match.source.schema,
                target_connection_id=match.omni_connection_id,
                target_connection_name=match.omni_connection_name,
                target_dialect=target.get("dialect") if target else None,
                target_database=match.omni_database,
                target_default_schema=match.omni_default_schema,
                confidence=match.confidence,
                reason=match.reason,
                candidate_ids=sorted(
                    item["id"] for item in match.candidates if isinstance(item.get("id"), str)
                ),
                # Always return the complete destination inventory. Suggested
                # candidate_ids remain dialect-aware, while the control plane can
                # still let a reviewer make an explicit cross-dialect override.
                candidates=[BridgeTargetConnection(
                    id=item["id"],
                    name=item["name"],
                    dialect=item.get("dialect") or "other",
                    database=item.get("database"),
                    default_schema=item.get("defaultSchema"),
                ) for item in target_connections if isinstance(item.get("id"), str) and isinstance(item.get("name"), str)],
                confirmed=source_key in request.connection_overrides,
            ))

    suggestions = []
    if request.include_model_suggestions:
        for path, content in emit_model(bundle.model, include_review_required=False).items():
            source_ids, evidence, suggestion_notes = _suggestion_provenance(bundle, path)
            severity = _severity(suggestion_notes)
            confidence = 0.95 if not suggestion_notes else 0.8 if severity == "info" else 0.65 if severity == "warning" else 0.35
            suggestions.append(BridgeModelSuggestion(
                path=path,
                content=content,
                sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
                parser_version=__version__,
                rulebook_version=request.rulebook_version,
                rulebook_sha256=rulebook_sha256,
                confidence=confidence,
                severity=severity,
                source_ids=sorted(set(source_ids)),
                evidence=evidence,
            ))

    notes = _notes(bundle)
    return BridgeExtractResult(
        request_id=request.request_id,
        engine={"name": "omni-migrator", "version": __version__},
        source=source,
        mode=request.mode,
        provenance={
            "source_artifacts": source_names,
            "source_artifact_fingerprints": source_fingerprints,
            "source_artifact_count": len(source_names),
            "ir_version": bundle.ir_version,
        },
        capability_coverage=capabilities,
        bundle=bundle,
        model_suggestions=suggestions,
        connection_mappings=connection_mappings,
        diagnostics=BridgeDiagnostics(
            view_count=len(bundle.model.views),
            topic_count=len(bundle.model.topics),
            dashboard_count=len(bundle.dashboards),
            field_count=sum(len(view.fields) for view in bundle.model.views),
            untranslatable_count=len(notes),
            source_artifact_count=len(source_names),
            limitations=LIMITATIONS[source],
            rulebook_version=request.rulebook_version,
            rulebook_sha256=rulebook_sha256,
            acquisition_contract_version=bundle.acquisition.contract_version if bundle.acquisition else None,
            saved_look_coverage=bundle.acquisition.saved_look_coverage if bundle.acquisition else None,
            dependency_closure_status=bundle.acquisition.dependency_closure_status if bundle.acquisition else None,
            source_query_validation_status=bundle.acquisition.source_query_validation_status if bundle.acquisition else None,
        ),
    )


def parse_and_execute_bridge_extract(payload: str) -> str:
    request = BridgeExtractRequest.model_validate_json(payload)
    return execute_bridge_extract(request).model_dump_json()

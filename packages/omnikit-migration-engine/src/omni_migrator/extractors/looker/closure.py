"""Selected-scope LookML dependency closure for Manual and API acquisition."""

from __future__ import annotations

import fnmatch
import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import lkml

from omni_migrator.ir.schema import AcquisitionDependencyIR, DashboardIR


_CONSTANT_REFERENCE = re.compile(r"@\{([^}]+)\}")


@dataclass
class LookerClosureReport:
    status: str
    dependencies: list[AcquisitionDependencyIR] = field(default_factory=list)
    required_files: list[str] = field(default_factory=list)
    unrelated_files: list[str] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)


def _source_keys(
    paths: list[Path],
    source_root: Path | None,
) -> dict[str, Path]:
    resolved = [path.resolve() for path in paths]
    if source_root is not None:
        root = source_root.resolve()
    elif resolved:
        root = Path(os.path.commonpath([str(path.parent) for path in resolved]))
    else:
        root = Path(".").resolve()
    result: dict[str, Path] = {}
    for path in resolved:
        try:
            relative = path.relative_to(root)
        except ValueError:
            relative = Path(path.name)
        key = PurePosixPath(*relative.parts).as_posix()
        if key in result:
            raise ValueError(f"Duplicate normalized Looker source path: {key}")
        result[key] = path
    return result


def _namespace(key: str, project_ids: list[str]) -> tuple[str | None, str]:
    parts = PurePosixPath(key).parts
    if parts and parts[0] in project_ids:
        return parts[0], PurePosixPath(*parts[1:]).as_posix()
    return None, key


def _match_include(
    pattern: str,
    model_key: str,
    keys: list[str],
    project_ids: list[str],
) -> list[str]:
    current_project, model_relative = _namespace(model_key, project_ids)
    model_parent = PurePosixPath(model_relative).parent
    raw = pattern.replace("\\", "/").strip()
    dependency_project: str | None = None
    if raw.startswith("//"):
        pieces = raw[2:].split("/", 1)
        dependency_project = pieces[0]
        raw = pieces[1] if len(pieces) > 1 else "*"
    elif raw.startswith("/"):
        raw = raw[1:]
    else:
        raw = (model_parent / raw).as_posix()
    candidates: list[str] = []
    for key in keys:
        project, relative = _namespace(key, project_ids)
        expected_project = dependency_project or current_project
        if expected_project is not None and project != expected_project:
            continue
        if fnmatch.fnmatchcase(relative, raw):
            candidates.append(key)
    return sorted(candidates)


def _names(value) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        output: list[str] = []
        for item in value:
            if isinstance(item, str):
                output.append(item)
            elif isinstance(item, list):
                output.extend(_names(item))
        return output
    return []


def analyze_looker_dependency_closure(
    paths: list[Path],
    dashboards: list[DashboardIR],
    *,
    project_ids: list[str] | None = None,
    source_root: Path | None = None,
) -> LookerClosureReport:
    project_ids = sorted(set(project_ids or []))
    keyed_paths = _source_keys(paths, source_root)
    parseable = {
        key: path for key, path in keyed_paths.items()
        if path.name.lower().endswith((".lkml", ".lookml"))
        and not path.name.lower().endswith(".dashboard.lookml")
    }
    parsed: dict[str, dict] = {}
    raw_text: dict[str, str] = {}
    for key, path in parseable.items():
        text = path.read_text()
        raw_text[key] = text
        parsed[key] = lkml.load(text)

    model_candidates: dict[str, list[str]] = {}
    for key in parsed:
        if key.endswith(".model.lkml"):
            name = PurePosixPath(key).name.removesuffix(".model.lkml")
            model_candidates.setdefault(name, []).append(key)
    manifest_files = [key for key in parsed if PurePosixPath(key).name == "manifest.lkml"]
    dashboard_models: dict[str, set[str]] = {}
    dashboard_explores: dict[tuple[str, str], set[str]] = {}
    dashboard_views: dict[tuple[str, str], set[str]] = {}
    for dashboard in dashboards:
        dashboard_id = dashboard.native_source_id or dashboard.source_id or dashboard.name
        for tile in dashboard.tiles:
            query = tile.query
            if not query:
                continue
            model_name = str(query.source_model or "").strip()
            explore_name = str(query.source_explore or query.topic or "").strip()
            if model_name:
                dashboard_models.setdefault(model_name, set()).add(dashboard_id)
            if model_name and explore_name:
                dashboard_explores.setdefault((model_name, explore_name), set()).add(dashboard_id)
            for field_name in [*query.fields, *query.hidden_fields, *query.calculation_dependencies]:
                if "." in field_name and model_name:
                    dashboard_views.setdefault((model_name, field_name.split(".", 1)[0]), set()).add(dashboard_id)

    relevant_models = sorted(dashboard_models) if dashboard_models else sorted(model_candidates)
    dependencies: list[AcquisitionDependencyIR] = []
    required_files: set[str] = {
        key for key, path in keyed_paths.items()
        if path.name.lower().endswith((".dashboard.lookml", ".look.json", ".looks.json"))
    }

    for model_name in relevant_models:
        affected = sorted(dashboard_models.get(model_name, set()))
        candidates = sorted(model_candidates.get(model_name, []))
        model_key = candidates[0] if len(candidates) == 1 else None
        if not model_key:
            reason = (
                f"Selected dashboard scope references missing model {model_name}."
                if not candidates else f"Model {model_name} is ambiguous across {len(candidates)} selected projects."
            )
            dependencies.append(AcquisitionDependencyIR(
                kind="model", reference=model_name, status="missing", required=True,
                matched_files=candidates,
                affected_dashboard_ids=affected,
                message=reason,
            ))
            continue
        required_files.add(model_key)
        model = parsed[model_key]
        dependencies.append(AcquisitionDependencyIR(
            kind="model", reference=model_name, source_file=model_key, status="resolved",
            matched_files=[model_key], affected_dashboard_ids=affected,
            message=f"Resolved Looker model {model_name}.",
        ))
        matched_includes: set[str] = set()
        for include in _names(model.get("includes") or model.get("include")):
            matches = _match_include(include, model_key, list(parsed), project_ids)
            dependencies.append(AcquisitionDependencyIR(
                kind="include", reference=include, source_file=model_key,
                status="resolved" if matches else "missing", required=True,
                matched_files=matches, affected_dashboard_ids=affected,
                message=(
                    f"Resolved include {include} to {len(matches)} file(s)."
                    if matches else f"Required include {include} did not match uploaded or API project files."
                ),
            ))
            matched_includes.update(matches)
            required_files.update(matches)
        view_definitions: dict[str, tuple[str, dict]] = {}
        refinements: list[tuple[str, str, dict]] = []
        for key in {model_key, *matched_includes}:
            for view in parsed.get(key, {}).get("views", []):
                if isinstance(view, dict) and view.get("name"):
                    raw_name = str(view["name"])
                    if raw_name.startswith("+"):
                        refinements.append((raw_name[1:], key, view))
                    elif raw_name not in view_definitions:
                        view_definitions[raw_name] = (key, view)
                    else:
                        dependencies.append(AcquisitionDependencyIR(
                            kind="view", reference=raw_name, source_file=key,
                            status="missing", required=True,
                            matched_files=[view_definitions[raw_name][0], key],
                            affected_dashboard_ids=affected,
                            message=f"View {raw_name} has duplicate definitions in the selected include closure.",
                        ))
        available_views = set(view_definitions)
        explores = {
            str(item.get("name")): item for item in model.get("explores", [])
            if isinstance(item, dict) and item.get("name")
        }
        required_views: dict[str, set[str]] = {
            view_name: set(view_dashboards)
            for (required_model, view_name), view_dashboards in dashboard_views.items()
            if required_model == model_name
        }
        for (required_model, explore_name), explore_dashboards in dashboard_explores.items():
            if required_model != model_name:
                continue
            explore = explores.get(explore_name)
            dependencies.append(AcquisitionDependencyIR(
                kind="explore", reference=explore_name, source_file=model_key,
                status="resolved" if explore else "missing", required=True,
                affected_dashboard_ids=sorted(explore_dashboards),
                message=(f"Resolved Explore {explore_name}." if explore else f"Selected dashboard references missing Explore {explore_name}."),
            ))
            if explore:
                base_view = str(explore.get("from") or explore_name)
                required_views.setdefault(base_view, set()).update(explore_dashboards)
                for join in explore.get("joins", []):
                    if isinstance(join, dict) and join.get("name"):
                        required_views.setdefault(str(join.get("from") or join["name"]), set()).update(explore_dashboards)
        for view_name, view_dashboards in sorted(required_views.items()):
            dependencies.append(AcquisitionDependencyIR(
                kind="view", reference=view_name, source_file=model_key,
                status="resolved" if view_name in available_views else "missing", required=True,
                affected_dashboard_ids=sorted(view_dashboards),
                message=(f"Resolved selected query view {view_name}." if view_name in available_views else f"Selected query references missing view {view_name}."),
            ))

        pending = list(required_views)
        visited: set[str] = set()
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            definition = view_definitions.get(name)
            if not definition:
                continue
            key, view = definition
            for parent in _names(view.get("extends") or view.get("extends__all")):
                dependencies.append(AcquisitionDependencyIR(
                    kind="extension", reference=parent, source_file=key,
                    status="resolved" if parent in available_views else "missing", required=True,
                    matched_files=[view_definitions[parent][0]] if parent in view_definitions else [],
                    affected_dashboard_ids=affected,
                    message=(f"Resolved extension parent {parent} for {name}." if parent in available_views else f"View {name} extends missing view {parent}."),
                ))
                pending.append(parent)
        for base_name, key, _view in refinements:
            if base_name not in required_views:
                continue
            dependencies.append(AcquisitionDependencyIR(
                kind="refinement", reference=base_name, source_file=key,
                status="resolved" if base_name in available_views else "missing", required=True,
                matched_files=[view_definitions[base_name][0]] if base_name in view_definitions else [],
                affected_dashboard_ids=affected,
                message=(f"Resolved refinement base {base_name}." if base_name in available_views else f"Refinement +{base_name} has no base view {base_name}."),
            ))

    constants: set[str] = set()
    manifest_dependencies: dict[str, str] = {}
    for key in manifest_files:
        manifest = parsed[key]
        for constant in manifest.get("constants", []):
            if isinstance(constant, dict) and constant.get("name"):
                constants.add(str(constant["name"]))
        for dependency in [*manifest.get("local_dependencies", []), *manifest.get("remote_dependencies", [])]:
            if isinstance(dependency, dict) and dependency.get("name"):
                manifest_dependencies[str(dependency["name"])] = key
    relevant_text = "\n".join(raw_text[key] for key in required_files if key in raw_text)
    for constant in sorted(set(_CONSTANT_REFERENCE.findall(relevant_text))):
        dependencies.append(AcquisitionDependencyIR(
            kind="constant", reference=constant,
            source_file=manifest_files[0] if manifest_files else None,
            status="resolved" if constant in constants else "missing", required=True,
            matched_files=manifest_files if constant in constants else [],
            affected_dashboard_ids=sorted({item for values in dashboard_models.values() for item in values}),
            message=(f"Resolved manifest constant {constant}." if constant in constants else f"Required manifest constant {constant} is missing."),
        ))
        if constant in constants:
            required_files.update(manifest_files)
    remote_references = set(re.findall(r'//([^/"\s]+)/', relevant_text))
    for dependency_name in sorted(remote_references):
        matched = [key for key in keyed_paths if _namespace(key, project_ids)[0] == dependency_name]
        dependencies.append(AcquisitionDependencyIR(
            kind="manifest_dependency", reference=dependency_name,
            source_file=manifest_dependencies.get(dependency_name),
            status="resolved" if matched else "missing", required=True,
            matched_files=matched,
            affected_dashboard_ids=sorted({item for values in dashboard_models.values() for item in values}),
            message=(f"Resolved project dependency {dependency_name}." if matched else f"Required project dependency {dependency_name} is not present in the selected evidence."),
        ))
        required_files.update(matched)

    missing = [item for item in dependencies if item.required and item.status == "missing"]
    review = [item for item in dependencies if item.required and item.status == "review"]
    status = "blocked" if missing else "partial" if review else "complete"
    all_files = set(keyed_paths)
    unrelated = sorted(all_files - required_files)
    diagnostics = [item.message for item in missing]
    return LookerClosureReport(
        status=status,
        dependencies=dependencies,
        required_files=sorted(required_files),
        unrelated_files=unrelated,
        diagnostics=diagnostics,
    )

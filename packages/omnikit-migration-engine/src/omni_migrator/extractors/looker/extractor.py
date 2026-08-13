"""Looker (LookML) extractor: .lkml files -> canonical IR.

Parsing is delegated to `lkml` (the standard pure-Python LookML parser) — we never
hand-roll LookML parsing. This module owns only the *mapping* (plan §6.3, Appendix A.3):
LookML view/dimension/measure/dimension_group -> ViewIR/FieldIR.

Out of scope for this first slice (flagged as untranslatable, not silently dropped):
explores->topics with joins, liquid, extends/refinements, sets, native derived tables.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import lkml
import yaml

from omni_migrator.core.contracts import ApiInput, ExtractCtx, ExtractorInput, FileInput
from omni_migrator.deterministic.formats import map_value_format
from omni_migrator.deterministic.sql_cleanup import clean_sql
from omni_migrator.extractors.looker.api import LookerApi, normalize_looker_dialect
from omni_migrator.extractors.looker.closure import analyze_looker_dependency_closure
from omni_migrator.extractors.looker.dashboard import translate_looker_dashboard, translate_looker_dashboard_lookml
from omni_migrator.ir.identity import content_sha256
from omni_migrator.ir.schema import (
    AcquisitionDependencyIR,
    AcquisitionEvidenceIR,
    FieldIR,
    JoinIR,
    MigrationBundle,
    ModelIR,
    Provenance,
    SemanticRequirementIR,
    SourceEvidence,
    TopicIR,
    UntranslatableNote,
    ViewIR,
)

# LookML dimension `type` -> IR data_type (Appendix A.3). Omni maps date->timestamp later.
_DIM_TYPE: dict[str, str] = {
    "string": "string", "tier": "string", "location": "string", "zipcode": "string",
    "number": "number", "int": "number",
    "yesno": "boolean",
    "date": "date", "date_time": "timestamp", "time": "timestamp",
}
# LookML measure `type` -> Omni aggregate (Appendix A.3).
_MEASURE_AGG: dict[str, str] = {
    "sum": "sum", "average": "average", "count": "count",
    "count_distinct": "count_distinct", "min": "min", "max": "max",
    "median": "median", "percentile": "percentile", "list": "list",
}
# Result-relative Looker measure types cannot be represented in model SQL. `number`
# is different: it is a reusable compound measure and Omni supports measures with
# raw aggregate SQL and no aggregate_type.
_MEASURE_TABLE_CALC = {"running_total", "percent_of_total", "yesno", "int"}

_TABLE_COL = re.compile(r"\$\{TABLE\}\.(\w+)")
_VIEW_REF = re.compile(r"\$\{(\w+)\.\w+\}")
_LIQUID = re.compile(r"(?:\{%|\{\{)")
_USER_ATTRIBUTE_REF = re.compile(
    r"_user_attributes\s*\[\s*['\"]([^'\"]+)['\"]\s*\]",
    re.IGNORECASE,
)
_PDT_PERSISTENCE_KEYS = (
    "datagroup_trigger",
    "interval_trigger",
    "persist_for",
    "persist_with",
    "sql_trigger_value",
    "indexes",
    "partition_keys",
    "cluster_keys",
    "distribution",
    "distribution_style",
    "sortkeys",
)

# LookML join `type` -> Omni join_type (Appendix A.4).
_JOIN_TYPE: dict[str, str] = {
    "left_outer": "always_left",
    "inner": "always_inner",
    "full_outer": "always_full",
    "cross": "always_inner",  # nearest; flagged below
}
# LookML join `relationship` -> Omni relationship_type (Appendix A.4).
_RELATIONSHIP: dict[str, str] = {
    "many_to_one": "many_to_one",
    "one_to_many": "one_to_many",
    "one_to_one": "one_to_one",
    "many_to_many": "many_to_many",
}


def _artifact_metadata(inp: FileInput, path: Path) -> dict | None:
    return inp.artifact_metadata.get(path) or inp.artifact_metadata.get(path.resolve())


def _stamp_direct_evidence(value, locator: str, metadata: dict | None) -> None:
    """Attach one exact source artifact to a parsed IR node.

    The bridge retains the complete upload manifest at bundle provenance. Repeating
    that manifest on every field makes output grow by artifacts x semantic objects.
    """
    if not metadata:
        return
    resolved_locator = value.source_locator or locator
    if not value.source_locator:
        value.source_locator = resolved_locator
    if not value.evidence:
        value.evidence = [SourceEvidence(
            artifact_name=str(metadata.get("name") or "") or None,
            artifact_sha256=str(metadata.get("sha256") or "") or None,
            locator=resolved_locator,
            content_sha256=content_sha256(value),
            role="direct",
        )]


def _stamp_requirement(requirement: SemanticRequirementIR, metadata: dict | None) -> None:
    locator = requirement.source_locator or (
        f"semantic-requirement:{requirement.object_type}:{requirement.name}:"
        f"{content_sha256(requirement)[:12]}"
    )
    _stamp_direct_evidence(requirement, locator, metadata)


def _stamp_view(view: ViewIR, requirements: list[SemanticRequirementIR], metadata: dict | None) -> None:
    view_locator = view.source_locator or f"view:{view.name}"
    _stamp_direct_evidence(view, view_locator, metadata)
    for field in view.fields:
        field_locator = field.source_locator or f"{view_locator}/field:{field.source_name or field.name}"
        _stamp_direct_evidence(field, field_locator, metadata)
    for requirement in requirements:
        _stamp_requirement(requirement, metadata)


def _stamp_topic(topic: TopicIR, requirements: list[SemanticRequirementIR], metadata: dict | None) -> None:
    topic_locator = topic.source_locator or f"topic:{topic.name}"
    _stamp_direct_evidence(topic, topic_locator, metadata)
    for join in topic.joins:
        join_locator = join.source_locator or (
            f"{topic_locator}/join:{join.join_from_view}->{join.join_to_view}:{join.on_sql}"
        )
        _stamp_direct_evidence(join, join_locator, metadata)
    for requirement in requirements:
        _stamp_requirement(requirement, metadata)


def _stamp_dashboard(dashboard, metadata: dict | None, saved_look_metadata: dict[str, dict]) -> None:
    dashboard_locator = dashboard.source_locator or f"dashboard:{dashboard.source_url or dashboard.name}"
    _stamp_direct_evidence(dashboard, dashboard_locator, metadata)
    for filter_item in dashboard.filters:
        filter_locator = filter_item.source_locator or (
            f"{dashboard_locator}/filter:{filter_item.field}:{filter_item.operator}:"
            f"{content_sha256(filter_item)[:12]}"
        )
        _stamp_direct_evidence(filter_item, filter_locator, metadata)
    for tile in dashboard.tiles:
        tile_key = tile.source_locator or tile.title or content_sha256(tile)[:16]
        tile_locator = tile.source_locator or f"{dashboard_locator}/tile:{tile_key}"
        _stamp_direct_evidence(tile, tile_locator, metadata)
        if tile.query:
            query_metadata = saved_look_metadata.get(tile.query.source_look_id or "") or metadata
            query_locator = tile.query.source_locator or f"{tile_locator}/query"
            _stamp_direct_evidence(tile.query, query_locator, query_metadata)
            for filter_item in tile.query.filters:
                filter_locator = filter_item.source_locator or (
                    f"{query_locator}/filter:{filter_item.field}:{filter_item.operator}:"
                    f"{content_sha256(filter_item)[:12]}"
                )
                _stamp_direct_evidence(filter_item, filter_locator, query_metadata)
            for dynamic_field in tile.query.dynamic_fields:
                dynamic_locator = dynamic_field.source_locator or (
                    f"{query_locator}/dynamic:{dynamic_field.name}:"
                    f"{content_sha256(dynamic_field)[:12]}"
                )
                _stamp_direct_evidence(dynamic_field, dynamic_locator, query_metadata)
    for binding in dashboard.filter_bindings:
        binding_locator = binding.source_locator or (
            f"{dashboard_locator}/binding:{binding.dashboard_filter_id}->{binding.tile_id}:"
            f"{binding.target_field or 'excluded'}"
        )
        _stamp_direct_evidence(binding, binding_locator, metadata)


def _yes(v) -> bool:
    return v is True or str(v).lower() in {"yes", "true"}


def _string_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value in (None, ""):
        return []
    return [str(value).strip()]


def _user_attribute_references(value) -> list[str]:
    references: set[str] = set()

    def visit(current) -> None:
        if isinstance(current, dict):
            for key, item in current.items():
                if key == "user_attribute" and item not in (None, ""):
                    references.add(str(item).strip())
                visit(item)
            return
        if isinstance(current, list):
            for item in current:
                visit(item)
            return
        if isinstance(current, str):
            references.update(match.strip() for match in _USER_ATTRIBUTE_REF.findall(current))

    visit(value)
    return sorted(item for item in references if item)


def _required_grants_requirement(
    *,
    object_name: str,
    record: dict,
    target_file_hint: str,
) -> SemanticRequirementIR | None:
    grants = _string_list(record.get("required_access_grants"))
    if not grants:
        return None
    return SemanticRequirementIR(
        object_type="permission",
        name=f"{object_name} required access grants",
        support_outcome="manual",
        reason=(
            "Looker required_access_grants restrict this object. Map the referenced grants "
            "and user attributes to reviewed Omni access controls before emitting target YAML."
        ),
        target_file_hint=target_file_hint,
        dependencies=grants,
        config={"required_access_grants": grants},
    )


def _field_governance_requirements(
    *,
    view_name: str,
    field: dict,
) -> list[SemanticRequirementIR]:
    field_name = str(field.get("name") or "field")
    target_file_hint = f"{view_name}.view"
    requirements: list[SemanticRequirementIR] = []
    required_grants = _required_grants_requirement(
        object_name=f"field {view_name}.{field_name}",
        record=field,
        target_file_hint=target_file_hint,
    )
    if required_grants:
        requirements.append(required_grants)
    for index, action in enumerate(field.get("actions") or []):
        if not isinstance(action, dict):
            continue
        requirements.append(SemanticRequirementIR(
            object_type="action",
            name=f"field action {view_name}.{field_name} #{index + 1}",
            support_outcome="unsupported",
            reason=(
                "Looker data actions can call external services and carry form or user-attribute "
                "payloads. OmniKit does not generate an equivalent side effect automatically."
            ),
            target_file_hint=target_file_hint,
            dependencies=_user_attribute_references(action),
            config={
                "label": str(action.get("label") or ""),
                "source_parameters": sorted(str(key) for key in action),
                "has_url": bool(action.get("url")),
                "has_form_url": bool(action.get("form_url")),
                "user_attributes": _user_attribute_references(action),
            },
        ))
    return requirements


def _split_table(sql_table_name: str | None, default_schema: str | None):
    if not sql_table_name:
        return None, None
    parts = [item.strip().strip('"`[]') for item in sql_table_name.strip().split(".")]
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    return default_schema, parts[0]


def _refinement_requirement(view: dict) -> SemanticRequirementIR:
    refined_name = str(view.get("name") or "").removeprefix("+")
    return SemanticRequirementIR(
        object_type="refinement",
        name=f"view {refined_name}",
        support_outcome="manual",
        reason=(
            "Looker view refinements are order-sensitive. OmniKit preserved this refinement "
            "as review evidence but did not apply an unverified override to target YAML."
        ),
        target_file_hint=f"{refined_name}.view",
        dependencies=[refined_name],
        config={"refinement": view},
    )


def _dimension(d: dict) -> FieldIR:
    looker_type = (d.get("type") or "string").lower()
    return FieldIR(
        name=d["name"],
        source_name=d["name"],
        kind="dimension",
        data_type=_DIM_TYPE.get(looker_type, "string"),
        sql=clean_sql(d.get("sql")),
        value_format=map_value_format(d.get("value_format_name"), source="looker"),
        label=d.get("label"),
        description=d.get("description"),
        group_label=d.get("group_label"),
        hidden=_yes(d.get("hidden")),
        primary_key=_yes(d.get("primary_key")),
    )


def _dimension_group(g: dict) -> FieldIR:
    """A time dimension_group collapses to ONE timestamp dimension (Appendix A.6).

    Name from the ${TABLE}.col base when available (matches Appendix A.11), else the
    group name. Timeframes are dropped — Omni derives them.
    """
    sql = g.get("sql")
    col = _TABLE_COL.search(sql) if sql else None
    name = col.group(1) if col else g["name"]
    return FieldIR(
        name=name,
        source_name=g["name"],
        kind="dimension",
        data_type="timestamp",
        sql=clean_sql(sql),
        label=g.get("label"),
        group_label=g.get("group_label"),
        hidden=_yes(g.get("hidden")),
        timeframes=g.get("timeframes"),
    )


def _flatten_filter_items(value) -> list[tuple[str, str]]:
    """Normalize the nested shapes emitted by ``lkml`` for Looker filter blocks."""
    items: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"filters", "filters__all"}:
                items.extend(_flatten_filter_items(item))
            elif isinstance(item, (str, int, float, bool)):
                items.append((str(key), str(item)))
            else:
                items.extend(_flatten_filter_items(item))
    elif isinstance(value, list):
        for item in value:
            items.extend(_flatten_filter_items(item))
    return items


def _omni_filter_condition(value: str) -> dict[str, str]:
    normalized = value.strip()
    if normalized.startswith("-") and len(normalized) > 1:
        return {"not": normalized[1:]}
    return {"is": normalized}


def _parameter(parameter: dict) -> FieldIR:
    looker_type = str(parameter.get("type") or "string").lower()
    data_type = {
        "number": "number",
        "date": "timestamp",
        "date_time": "timestamp",
        "yesno": "boolean",
    }.get(looker_type, "string")
    allowed_values = [
        {
            "value": str(item.get("value") or ""),
            **({"label": str(item["label"])} if item.get("label") else {}),
        }
        for item in parameter.get("allowed_values", [])
        if isinstance(item, dict) and item.get("value") is not None
    ]
    return FieldIR(
        name=parameter["name"],
        source_name=parameter["name"],
        kind="parameter",
        data_type=data_type,
        label=parameter.get("label"),
        description=parameter.get("description"),
        hidden=_yes(parameter.get("hidden")),
        suggestion_list=allowed_values or None,
        filter_single_select_only=bool(allowed_values),
    )


def _parameter_yaml(field: FieldIR) -> str:
    definition: dict = {"type": "timestamp" if field.data_type == "date" else field.data_type}
    if field.label:
        definition["label"] = field.label
    if field.description:
        definition["description"] = field.description
    if field.hidden:
        definition["hidden"] = True
    if field.suggestion_list:
        definition["suggestion_list"] = field.suggestion_list
    if field.filter_single_select_only:
        definition["filter_single_select_only"] = True
    return yaml.safe_dump({"filters": {field.name: definition}}, sort_keys=False)


def _measure(
    m: dict,
    current_view: str | None = None,
    requirements: list[SemanticRequirementIR] | None = None,
) -> tuple[FieldIR | None, UntranslatableNote | None]:
    looker_type = (m.get("type") or "count").lower()
    if looker_type in _MEASURE_TABLE_CALC:
        return None, UntranslatableNote(
            object=f"measure {m['name']}",
            reason=f"Looker measure type '{looker_type}' maps to an Omni table calculation, "
            "not a model measure.",
            severity="warning",
            hint=str(m.get("sql") or m.get("type")),
        )
    agg = _MEASURE_AGG.get(looker_type)
    if looker_type == "number":
        sql = clean_sql(m.get("sql"))
        if not sql:
            return None, UntranslatableNote(
                object=f"measure {m['name']}",
                reason="Looker number measure has no reusable SQL expression.",
                severity="warning",
            )
        return FieldIR(
            name=m["name"],
            source_name=m["name"],
            kind="measure",
            data_type="number",
            sql=sql,
            aggregate=None,
            value_format=map_value_format(m.get("value_format_name"), source="looker"),
            label=m.get("label"),
            description=m.get("description"),
            hidden=_yes(m.get("hidden")),
        ), None
    if agg is None:
        return None, UntranslatableNote(
            object=f"measure {m['name']}",
            reason=f"Unsupported Looker measure type '{looker_type}'.",
            severity="warning",
        )
    filters: dict[str, dict] | None = None
    raw_filters = m.get("filters") or m.get("filters__all")
    if raw_filters:
        normalized_filters: dict[str, dict] = {}
        cross_view_filters: dict[str, dict] = {}
        for key, value in _flatten_filter_items(raw_filters):
            if "." in key:
                view_name, field_name = key.split(".", 1)
                if current_view and view_name == current_view:
                    normalized_filters[field_name] = _omni_filter_condition(value)
                else:
                    cross_view_filters[key] = _omni_filter_condition(value)
            else:
                normalized_filters[key] = _omni_filter_condition(value)
        filters = normalized_filters or None
        if cross_view_filters and requirements is not None:
            requirements.append(SemanticRequirementIR(
                object_type="filtered_measure",
                name=f"{current_view or 'view'}.{m['name']}",
                support_outcome="decision_required",
                reason=(
                    "Cross-view filtered measures require a target-aware rewrite, typically "
                    "a PDT or a reviewed compound measure."
                ),
                target_file_hint=f"{current_view}.view" if current_view else None,
                dependencies=sorted(cross_view_filters),
                config={"filters": cross_view_filters, "measure_type": looker_type},
            ))
    field = FieldIR(
        name=m["name"],
        source_name=m["name"],
        kind="measure",
        data_type="number",
        sql=clean_sql(m.get("sql")),
        aggregate=agg,
        value_format=map_value_format(m.get("value_format_name"), source="looker"),
        label=m.get("label"),
        description=m.get("description"),
        hidden=_yes(m.get("hidden")),
        filters=filters,
    )
    return field, None


def _view(
    v: dict,
    default_schema: str | None,
    requirements: list[SemanticRequirementIR] | None = None,
) -> ViewIR:
    requirements = requirements if requirements is not None else []
    notes: list[UntranslatableNote] = []
    if "extends" in v or "extends__all" in v:
        requirements.append(SemanticRequirementIR(
            object_type="extension",
            name=f"view {v['name']}",
            support_outcome="decision_required",
            reason="LookML view extension inheritance must be flattened or preserved by an explicit reviewer decision.",
            target_file_hint=f"{v['name']}.view",
            config={"extends": v.get("extends") or v.get("extends__all")},
        ))
    if "sets" in v:
        notes.append(UntranslatableNote(object=f"view {v['name']}", reason="`set` belongs in the Omni model file; migrate manually.", severity="info"))

    schema_name = table = None
    sql = None
    if "sql_table_name" in v:
        schema_name, table = _split_table(v["sql_table_name"], default_schema)
    derived = v.get("derived_table")
    if derived and "sql" in derived:
        sql = derived["sql"]
        persistence = {
            key: derived[key]
            for key in _PDT_PERSISTENCE_KEYS
            if key in derived
        }
        if persistence:
            requirements.append(SemanticRequirementIR(
                object_type="derived_table",
                name=f"persistent derived table {v['name']}",
                support_outcome="manual",
                reason=(
                    "Looker SQL PDT persistence and rebuild semantics are not equivalent to an "
                    "ordinary Omni query view. Choose an upstream materialization or an explicitly "
                    "reviewed Omni implementation before migration."
                ),
                target_file_hint=f"{v['name']}.view",
                dependencies=_string_list(persistence.get("datagroup_trigger")),
                config={"persistence": persistence},
            ))
        if _LIQUID.search(str(sql)):
            requirements.append(SemanticRequirementIR(
                object_type="liquid",
                name=f"derived table {v['name']}",
                support_outcome="decision_required",
                reason="Looker Liquid in derived-table SQL requires an explicit Omni templating rewrite.",
                target_file_hint=f"{v['name']}.view",
                config={"sql": str(sql)},
            ))
    elif derived:
        notes.append(UntranslatableNote(object=f"view {v['name']}", reason="Native/PDT derived table not supported; needs manual SQL.", severity="blocker"))
        requirements.append(SemanticRequirementIR(
            object_type="derived_table",
            name=f"derived table {v['name']}",
            support_outcome="manual",
            reason="Native Explore-source and PDT derived tables require a reviewed SQL or query-view implementation.",
            target_file_hint=f"{v['name']}.view",
            dependencies=[str(derived.get("explore_source", {}).get("name") or "")],
            config={"derived_table": derived},
        ))

    view_grants = _required_grants_requirement(
        object_name=f"view {v['name']}",
        record=v,
        target_file_hint=f"{v['name']}.view",
    )
    if view_grants:
        requirements.append(view_grants)

    fields: list[FieldIR] = []
    for d in v.get("dimensions", []):
        requirements.extend(_field_governance_requirements(view_name=v["name"], field=d))
        fields.append(_dimension(d))
    for g in v.get("dimension_groups", []):
        requirements.extend(_field_governance_requirements(view_name=v["name"], field=g))
        fields.append(_dimension_group(g))
    for parameter in v.get("parameters", []):
        requirements.extend(_field_governance_requirements(view_name=v["name"], field=parameter))
        field = _parameter(parameter)
        fields.append(field)
        requirements.append(SemanticRequirementIR(
            object_type="parameter",
            name=f"{v['name']}.{field.name}",
            support_outcome="decision_required",
            reason="Looker parameter semantics require reviewer confirmation of the Omni filter-only field and template usage.",
            target_file_hint=f"{v['name']}.view",
            dependencies=[field.name],
            config={
                "data_type": field.data_type,
                "suggestion_list": field.suggestion_list or [],
                "filter_single_select_only": field.filter_single_select_only,
                "proposed_yaml": _parameter_yaml(field),
            },
        ))
    for m in v.get("measures", []):
        requirements.extend(_field_governance_requirements(view_name=v["name"], field=m))
        field, note = _measure(m, v["name"], requirements)
        if field:
            fields.append(field)
        if note:
            notes.append(note)

    for field in fields:
        if field.sql and _LIQUID.search(field.sql):
            requirements.append(SemanticRequirementIR(
                object_type="liquid",
                name=f"{v['name']}.{field.name}",
                support_outcome="decision_required",
                reason="Looker Liquid field SQL requires an explicit Omni templating rewrite.",
                target_file_hint=f"{v['name']}.view",
                dependencies=[field.name],
                config={"sql": field.sql},
            ))

    return ViewIR(
        name=v["name"],
        source_table=table,
        schema_name=schema_name,
        sql=sql,
        label=v.get("label"),
        description=v.get("description"),
        fields=fields,
        untranslatable=notes,
    )


def _join(
    base_view: str,
    join: dict,
    pk_by_view: dict[str, str | None],
    requirements: list[SemanticRequirementIR] | None = None,
    available_join_sources: set[str] | None = None,
) -> tuple[JoinIR | None, UntranslatableNote | None]:
    """Map one LookML `join` to a JoinIR.

    `join_to_view` is the joined view (honoring `from`/`view_name` aliases). A relationship
    is emitted only when `sql_on` or the Explore base provides one unambiguous source side.
    """
    join_to = join.get("view_name") or join.get("from") or join["name"]
    looker_type = (join.get("type") or "left_outer").lower()
    looker_rel = (join.get("relationship") or "many_to_one").lower()

    def blocked(reason: str) -> tuple[None, UntranslatableNote]:
        if requirements is not None:
            requirements.append(SemanticRequirementIR(
                object_type="lineage",
                name=f"join {base_view} to {join_to}",
                support_outcome="manual",
                reason=reason,
                target_file_hint=f"{base_view}.topic",
                dependencies=[base_view, str(join_to)],
                config={"join": join},
            ))
        return None, UntranslatableNote(
            object=f"join {join['name']}",
            reason=reason,
            severity="blocker",
        )

    if looker_type not in _JOIN_TYPE or looker_type == "cross":
        return blocked(
            f"Looker join type `{looker_type}` has no verified Omni mapping; the relationship was not emitted."
        )
    if looker_rel not in _RELATIONSHIP:
        return blocked(
            f"Looker relationship `{looker_rel}` has no verified Omni cardinality mapping; the relationship was not emitted."
        )

    on_sql = join.get("sql_on")
    if not on_sql:
        fk = join.get("foreign_key")
        if fk:
            target_pk = pk_by_view.get(join_to)
            if not target_pk:
                return blocked(
                    f"Looker foreign_key `{fk}` references `{join_to}`, but no explicit target primary key was found. OmniKit did not invent an `id` key."
                )
            on_sql = f"${{{base_view}.{fk}}} = ${{{join_to}.{target_pk}}}"
        else:
            return blocked(
                "Looker join has neither `sql_on` nor `foreign_key`; the relationship condition cannot be derived."
            )

    sources = available_join_sources or {base_view}
    refs = {m for m in _VIEW_REF.findall(on_sql)} - {str(join_to)}
    if base_view in refs:
        join_from = base_view
    else:
        evidenced_sources = sorted(refs & sources)
        if len(evidenced_sources) != 1:
            return blocked(
                "Looker join SQL does not identify exactly one previously established Explore source. "
                "OmniKit did not invent join direction."
            )
        join_from = evidenced_sources[0]

    return (
        JoinIR(
            join_from_view=join_from,
            join_to_view=join_to,
            join_type=_JOIN_TYPE.get(looker_type, "always_left"),
            relationship_type=_RELATIONSHIP.get(looker_rel, "many_to_one"),
            on_sql=on_sql,
        ),
        None,
    )


def _explore(
    e: dict,
    pk_by_view: dict[str, str | None],
    requirements: list[SemanticRequirementIR] | None = None,
) -> tuple[TopicIR, list[UntranslatableNote]]:
    requirements = requirements if requirements is not None else []
    base_view = e.get("from") or e.get("view_name") or e["name"]
    notes: list[UntranslatableNote] = []
    joins: list[JoinIR] = []
    available_join_sources = {base_view}
    for j in e.get("joins", []):
        join_ir, note = _join(
            base_view,
            j,
            pk_by_view,
            requirements,
            available_join_sources,
        )
        if join_ir:
            joins.append(join_ir)
            available_join_sources.add(join_ir.join_to_view)
        if note:
            notes.append(note)
        join_grants = _required_grants_requirement(
            object_name=f"join {e['name']}.{j.get('name') or 'join'}",
            record=j,
            target_file_hint=f"{e['name']}.topic",
        )
        if join_grants:
            requirements.append(join_grants)
    if "extends" in e or "extends__all" in e:
        requirements.append(SemanticRequirementIR(
            object_type="extension",
            name=f"explore {e['name']}",
            support_outcome="decision_required",
            reason="LookML Explore inheritance must be flattened or preserved by an explicit reviewer decision.",
            target_file_hint=f"{e['name']}.topic",
            config={"extends": e.get("extends") or e.get("extends__all")},
        ))
    explore_grants = _required_grants_requirement(
        object_name=f"explore {e['name']}",
        record=e,
        target_file_hint=f"{e['name']}.topic",
    )
    if explore_grants:
        requirements.append(explore_grants)
    always_where_filters = {
        key: _omni_filter_condition(value)
        for key, value in _flatten_filter_items(e.get("always_filter") or e.get("always_filters") or {})
    }
    if always_where_filters:
        requirements.append(SemanticRequirementIR(
            object_type="always_filter",
            name=f"explore {e['name']} always_filter",
            support_outcome="decision_required",
            reason="Looker always_filter conditions become Omni topic governance and require reviewer confirmation.",
            target_file_hint=f"{e['name']}.topic",
            dependencies=sorted(always_where_filters),
            config={
                "always_where_filters": always_where_filters,
                "proposed_yaml": yaml.safe_dump(
                    {"always_where_filters": always_where_filters}, sort_keys=False
                ),
            },
        ))
    access_filters = [
        {
            "field": str(item.get("field") or ""),
            "user_attribute": str(item.get("user_attribute") or ""),
        }
        for item in e.get("access_filters", [])
        if isinstance(item, dict) and item.get("field") and item.get("user_attribute")
    ]
    for access_filter in access_filters:
        requirements.append(SemanticRequirementIR(
            object_type="access_filter",
            name=f"explore {e['name']} access_filter {access_filter['field']}",
            support_outcome="decision_required",
            reason="Looker access_filter user attributes require an explicit identity and governance mapping in Omni.",
            target_file_hint=f"{e['name']}.topic",
            dependencies=[access_filter["field"], access_filter["user_attribute"]],
            config={
                **access_filter,
                "proposed_yaml": yaml.safe_dump(
                    {"access_filters": [access_filter]}, sort_keys=False
                ),
            },
        ))
    topic = TopicIR(
        name=e["name"],
        base_view=base_view,
        label=e.get("label"),
        description=e.get("description"),
        joins=joins,
        always_where_filters=always_where_filters,
        access_filters=access_filters,
    )
    return topic, notes


def resolve_dialects(model: ModelIR, name_to_dialect: dict[str, str]) -> int:
    """Set each view's connection dialect from the Looker connections API map.

    Returns the number of views updated. Run after extraction when API access exists,
    so connection mapping (which keys on dialect) works for Looker.
    """
    updated = 0
    for v in model.views:
        name = v.connection.source_connection_name
        if name and name in name_to_dialect:
            v.connection.dialect = name_to_dialect[name]
            updated += 1
    return updated


def _manual_saved_looks(path: Path) -> list[dict]:
    """Read an explicit companion Look export without accepting arbitrary JSON."""
    if not path.name.lower().endswith((".look.json", ".looks.json")):
        return []
    payload = json.loads(path.read_text())
    if isinstance(payload, dict) and isinstance(payload.get("looks"), list):
        rows = payload["looks"]
    elif isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = [payload]
    else:
        raise ValueError(f"Saved Look companion must contain an object or list: {path.name}")
    looks = [item for item in rows if isinstance(item, dict)]
    if any(item.get("id") in (None, "") for item in looks):
        raise ValueError(f"Every saved Look companion entry requires an id: {path.name}")
    return looks


def _saved_look_coverage(dashboards: list) -> tuple[str, list[str], list[str], list[str]]:
    look_ids: set[str] = set()
    query_ids: set[str] = set()
    unresolved: list[str] = []
    for dashboard in dashboards:
        for tile in dashboard.tiles:
            if tile.query and tile.query.source_look_id:
                look_ids.add(tile.query.source_look_id)
            if tile.query and tile.query.native_source_id:
                query_ids.add(tile.query.native_source_id)
            if tile.kind == "query" and tile.query is None:
                unresolved.append(f"{dashboard.name}: {tile.title or tile.native_source_id or 'tile'}")
    if unresolved:
        status = "blocked"
    elif look_ids:
        status = "complete"
    else:
        status = "not_applicable"
    return status, sorted(look_ids), sorted(query_ids), sorted(unresolved)


def _compiled_records(value) -> list[dict]:
    return [item for item in (value or []) if isinstance(item, dict)] if isinstance(value, list) else []


def _compiled_field_identity(field: dict) -> tuple[str, str, str]:
    qualified = str(field.get("name") or field.get("id") or "").strip()
    explicit_view = str(
        field.get("view") or field.get("view_name") or field.get("viewName") or ""
    ).strip()
    if "." in qualified:
        inferred_view, short_name = qualified.split(".", 1)
    else:
        inferred_view, short_name = "", qualified
    view_name = explicit_view or inferred_view
    return view_name, short_name, qualified or short_name


def _compiled_field_as_lookml(field: dict, *, kind: str, short_name: str) -> dict:
    record = {
        "name": short_name,
        "type": field.get("type") or ("count" if kind == "measure" else "string"),
        "sql": field.get("sql"),
        "label": field.get("label") or field.get("label_short"),
        "description": field.get("description"),
        "group_label": field.get("group_label") or field.get("groupLabel"),
        "hidden": field.get("hidden"),
        "primary_key": field.get("primary_key") or field.get("primaryKey"),
        "value_format_name": field.get("value_format_name") or field.get("valueFormatName"),
    }
    return {key: value for key, value in record.items() if value not in (None, "")}


def _compiled_explore_views(record: dict) -> dict[str, dict]:
    definition = record.get("definition") if isinstance(record.get("definition"), dict) else {}
    fields = definition.get("fields") if isinstance(definition.get("fields"), dict) else {}
    grouped: dict[str, dict] = {}

    def add(raw: dict, target: str) -> None:
        view_name, short_name, _qualified = _compiled_field_identity(raw)
        if not view_name or not short_name:
            return
        view = grouped.setdefault(
            view_name,
            {
                "name": view_name,
                "label": raw.get("view_label") or raw.get("viewLabel"),
                "dimensions": [],
                "measures": [],
                "parameters": [],
            },
        )
        view[target].append(
            _compiled_field_as_lookml(
                raw,
                kind="measure" if target == "measures" else "dimension",
                short_name=short_name,
            )
        )

    for raw in _compiled_records(fields.get("dimensions")):
        add(raw, "dimensions")
    for raw in _compiled_records(fields.get("measures")):
        add(raw, "measures")
    for raw in _compiled_records(fields.get("parameters")):
        add(raw, "parameters")
    return grouped


def _compiled_explore_as_lookml(record: dict) -> dict:
    definition = record.get("definition") if isinstance(record.get("definition"), dict) else {}
    explore_name = str(record.get("exploreName") or definition.get("name") or "").strip()
    base_view = str(
        definition.get("view_name")
        or definition.get("viewName")
        or definition.get("from")
        or explore_name
    ).strip()
    joins = []
    for raw in _compiled_records(definition.get("joins")):
        join_name = str(raw.get("name") or raw.get("view_name") or raw.get("viewName") or "").strip()
        if not join_name:
            continue
        joins.append(
            {
                "name": join_name,
                "from": raw.get("from") or raw.get("view_name") or raw.get("viewName"),
                "sql_on": raw.get("sql_on") or raw.get("sqlOn"),
                "relationship": raw.get("relationship"),
                "type": raw.get("type"),
                "required_access_grants": raw.get("required_access_grants")
                or raw.get("requiredAccessGrants"),
            }
        )
    access_filters = definition.get("access_filters") or definition.get("accessFilters") or []
    return {
        "name": explore_name,
        "from": base_view,
        "label": definition.get("label") or definition.get("title"),
        "description": definition.get("description"),
        "joins": joins,
        "always_filter": definition.get("always_filter") or definition.get("alwaysFilter"),
        "access_filters": access_filters if isinstance(access_filters, list) else [],
        "required_access_grants": definition.get("required_access_grants")
        or definition.get("requiredAccessGrants"),
    }


def _compiled_explore_pairs(raw) -> list[tuple[str, str]]:
    if not isinstance(raw, list):
        return []
    pairs: list[tuple[str, str]] = []
    for item in raw:
        if isinstance(item, dict):
            model = item.get("model") or item.get("model_name") or item.get("modelName")
            explore = item.get("explore") or item.get("explore_name") or item.get("exploreName")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            model, explore = item
        elif isinstance(item, str) and "/" in item:
            model, explore = item.split("/", 1)
        else:
            continue
        if str(model).strip() and str(explore).strip():
            pairs.append((str(model).strip(), str(explore).strip()))
    return list(dict.fromkeys(pairs))


def _build_compiled_api_bundle(snapshot: dict, ctx: ExtractCtx) -> MigrationBundle:
    acquisition = snapshot.get("_omnikit_acquisition")
    if not isinstance(acquisition, dict) or acquisition.get("contract") != "looker-compiled-api-v1":
        raise ValueError(
            "Looker API extraction requires an OmniKit looker-compiled-api-v1 snapshot"
        )
    if acquisition.get("rawLookmlRetrieved") is not False:
        raise ValueError("Looker compiled API evidence must not claim raw LookML retrieval")

    selected_records = _compiled_records(snapshot.get("explores"))
    if not selected_records:
        raise ValueError("Looker compiled API evidence contains no selected Explore definitions")

    model = ModelIR()
    view_by_name: dict[str, ViewIR] = {}
    view_fingerprints: dict[str, str] = {}
    diagnostics: list[str] = []
    dependencies: list[AcquisitionDependencyIR] = []

    for record in selected_records:
        model_name = str(record.get("modelName") or "").strip()
        explore_name = str(record.get("exploreName") or "").strip()
        definition = record.get("definition") if isinstance(record.get("definition"), dict) else {}
        if not model_name or not explore_name or not definition:
            raise ValueError("Every Looker compiled Explore record requires model, Explore, and definition")
        record_locator = f"compiled-explore:{model_name}/{explore_name}"
        metadata = {
            "name": record_locator,
            "sha256": content_sha256(definition),
        }
        dependencies.append(AcquisitionDependencyIR(
            kind="explore",
            reference=f"{model_name}/{explore_name}",
            status="resolved",
            message="Resolved through Looker's documented compiled Explore endpoint.",
        ))
        dependencies.append(AcquisitionDependencyIR(
            kind="include",
            reference=f"raw LookML closure for {model_name}/{explore_name}",
            status="review",
            message=(
                "Compiled Explore evidence does not replace raw LookML includes, refinements, "
                "Liquid, PDT SQL, manifests, or tests. Provide the selected Git/manual closure "
                "before release validation."
            ),
        ))

        for view_name, raw_view in _compiled_explore_views(record).items():
            candidate_fingerprint = content_sha256(raw_view)
            if view_name in view_by_name:
                if view_fingerprints[view_name] != candidate_fingerprint:
                    diagnostics.append(
                        f"Compiled view {view_name} differs across selected Explores; field-level "
                        "reconciliation is required before release."
                    )
                existing = view_by_name[view_name]
                existing_field_names = {field.source_name or field.name for field in existing.fields}
                candidate_requirements: list[SemanticRequirementIR] = []
                candidate = _view(raw_view, ctx.default_schema, candidate_requirements)
                for field in candidate.fields:
                    if (field.source_name or field.name) not in existing_field_names:
                        existing.fields.append(field)
                for requirement in candidate_requirements:
                    _stamp_requirement(requirement, metadata)
                model.requirements.extend(candidate_requirements)
                continue
            requirement_start = len(model.requirements)
            view = _view(raw_view, ctx.default_schema, model.requirements)
            view.source_locator = f"{record_locator}/view:{view_name}"
            connection_name = str(definition.get("connection_name") or definition.get("connectionName") or "").strip()
            view.connection.source_connection_name = connection_name or None
            _stamp_view(view, model.requirements[requirement_start:], metadata)
            view_by_name[view_name] = view
            view_fingerprints[view_name] = candidate_fingerprint
            model.views.append(view)

        requirement_start = len(model.requirements)
        topic, notes = _explore(
            _compiled_explore_as_lookml(record),
            {view.name: view.primary_key_field for view in model.views},
            model.requirements,
        )
        topic.source_locator = record_locator
        _stamp_topic(topic, model.requirements[requirement_start:], metadata)
        model.topics.append(topic)
        model.untranslatable.extend(notes)
        requirement = SemanticRequirementIR(
            object_type="lineage",
            name=f"raw LookML closure for {model_name}/{explore_name}",
            support_outcome="manual",
            reason=(
                "The Looker API supplies a compiled Explore definition, not the authoritative "
                "raw LookML files and include graph required for release-complete migration."
            ),
            target_file_hint=f"{explore_name}.topic",
            dependencies=[model_name, explore_name],
            config={"definition_class": "compiled_definition", "raw_lookml_retrieved": False},
        )
        _stamp_requirement(requirement, metadata)
        model.requirements.append(requirement)

    dashboard_rows = _compiled_records(snapshot.get("dashboards"))
    dashboards = [translate_looker_dashboard(row) for row in dashboard_rows]
    saved_look_status, look_ids, query_ids, unresolved = _saved_look_coverage(dashboards)
    for dashboard, raw in zip(dashboards, dashboard_rows, strict=True):
        metadata = {
            "name": f"dashboard:{dashboard.native_source_id or dashboard.name}",
            "sha256": content_sha256(raw),
        }
        _stamp_dashboard(dashboard, metadata, {})

    dialects: dict[str, str] = {}
    for connection in _compiled_records(snapshot.get("connections")):
        name = str(connection.get("name") or "").strip()
        dialect = connection.get("dialect")
        raw_dialect = connection.get("dialect_name") or (
            dialect.get("name") if isinstance(dialect, dict) else dialect
        )
        if name:
            dialects[name] = normalize_looker_dialect(
                str(raw_dialect) if raw_dialect not in (None, "") else None
            )
    resolve_dialects(model, dialects)

    project_ids = [str(item) for item in acquisition.get("projectIds", []) if str(item).strip()]
    dashboard_ids = [
        str(item.native_source_id) for item in dashboards if item.native_source_id
    ]
    return MigrationBundle(
        source="looker",
        provenance=Provenance(source_artifact="Looker compiled API definitions"),
        acquisition=AcquisitionEvidenceIR(
            contract_version="looker.compiled-api.v1",
            mode="api",
            project_ids=sorted(project_ids),
            dashboard_ids=sorted(dashboard_ids),
            look_ids=look_ids,
            query_ids=query_ids,
            dependencies=dependencies,
            saved_look_coverage=saved_look_status,
            dependency_closure_status="partial",
            source_query_validation_status="not_evaluated",
            diagnostics=[
                "Looker API acquisition contains compiled definitions only; raw LookML remains "
                "a Git or Manual Files dependency.",
                *[f"Unresolved query tile: {item}" for item in unresolved],
                *diagnostics,
            ],
        ),
        model=model,
        dashboards=dashboards,
    )


class LookerExtractor:
    source = "looker"

    def detect(self, inp: ExtractorInput) -> bool:
        return isinstance(inp, ApiInput) or isinstance(inp, FileInput) and any(
            str(p).endswith((".lkml", ".lookml", ".look.json", ".looks.json")) for p in inp.paths
        )

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx | None = None) -> MigrationBundle:
        ctx = ctx or ExtractCtx()
        if isinstance(inp, ApiInput):
            return self._extract_api(inp, ctx)
        if not isinstance(inp, FileInput):
            raise TypeError("LookerExtractor supports LookML FileInput or scoped Looker ApiInput.")
        return self._extract_files(inp, ctx)

    def _extract_files(
        self,
        inp: FileInput,
        ctx: ExtractCtx,
        *,
        acquisition_mode: str = "manual",
        project_ids: list[str] | None = None,
        source_root: Path | None = None,
        selected_dashboards: list | None = None,
    ) -> MigrationBundle:
        model = ModelIR()
        artifacts: list[str] = []
        parsed_files: dict[Path, tuple[dict, dict | None]] = {}
        dashboard_blocks: list[tuple[dict, dict | None]] = []
        saved_looks: dict[str, dict] = {}
        saved_look_metadata: dict[str, dict] = {}
        for path in inp.paths:
            path = Path(path)
            metadata = _artifact_metadata(inp, path)
            artifacts.append(str(path))
            look_rows = _manual_saved_looks(path)
            if look_rows:
                for look in look_rows:
                    look_id = str(look["id"])
                    if look_id in saved_looks:
                        raise ValueError(f"Duplicate saved Look id {look_id} in manual evidence")
                    saved_looks[look_id] = look
                    if metadata:
                        saved_look_metadata[look_id] = metadata
                continue
            if path.name.endswith(".dashboard.lookml"):
                parsed_dashboards = yaml.safe_load(path.read_text()) or []
                if isinstance(parsed_dashboards, dict):
                    parsed_dashboards = [parsed_dashboards]
                dashboard_blocks.extend(
                    (item, metadata) for item in parsed_dashboards if isinstance(item, dict)
                )
                continue
            with path.open() as fh:
                parsed = lkml.load(fh)
            parsed_files[path.resolve()] = (parsed, metadata)

        requested_dashboard_ids = (
            ctx.scope.get("dashboard_ids")
            or ctx.scope.get("selected_dashboard_ids")
            or []
        )
        if isinstance(requested_dashboard_ids, str):
            selected_ids = {requested_dashboard_ids}
        else:
            selected_ids = {
                str(item) for item in requested_dashboard_ids
                if str(item).strip()
            }
        dashboards = list(selected_dashboards or [])
        seen_dashboard_ids = {
            str(item.native_source_id) for item in dashboards if item.native_source_id
        }
        for item, metadata in dashboard_blocks:
            native_id = str(item.get("dashboard") or "").strip()
            if selected_ids and native_id not in selected_ids:
                continue
            dashboard = translate_looker_dashboard_lookml(item, saved_looks)
            if dashboard.native_source_id and dashboard.native_source_id in seen_dashboard_ids:
                continue
            _stamp_dashboard(dashboard, metadata, saved_look_metadata)
            dashboards.append(dashboard)
            if dashboard.native_source_id:
                seen_dashboard_ids.add(dashboard.native_source_id)

        saved_look_status, look_ids, query_ids, unresolved = _saved_look_coverage(dashboards)
        closure = analyze_looker_dependency_closure(
            [Path(item) for item in inp.paths],
            dashboards,
            project_ids=project_ids,
            source_root=source_root,
            logical_names={
                Path(path): str(metadata.get("name"))
                for path, metadata in inp.artifact_metadata.items()
                if isinstance(metadata, dict) and str(metadata.get("name") or "").strip()
            },
        )

        explores: list[tuple[dict, dict | None]] = []
        recorded_project_requirements: set[tuple[str, str]] = set()
        emitted_views: set[str] = set()
        for source_key in closure.required_files:
            source_path = closure.source_paths.get(source_key)
            if source_path is None:
                continue
            parsed_record = parsed_files.get(source_path.resolve())
            if parsed_record is None:
                continue
            parsed, metadata = parsed_record
            connection_candidates = closure.file_connections.get(source_key, [])
            explicit_connection = str(parsed.get("connection") or "").strip()
            if explicit_connection and explicit_connection not in connection_candidates:
                connection_candidates = [*connection_candidates, explicit_connection]
            file_connection = connection_candidates[0] if len(connection_candidates) == 1 else None
            if len(connection_candidates) > 1:
                requirement = SemanticRequirementIR(
                    object_type="lineage",
                    name=f"connection scope for {source_key}",
                    support_outcome="manual",
                    reason=(
                        "This LookML file is included by models with different connections. "
                        "OmniKit did not assign one connection to all emitted views."
                    ),
                    target_file_hint="model",
                    dependencies=connection_candidates,
                    config={"source_file": source_key, "connections": connection_candidates},
                )
                _stamp_requirement(requirement, metadata)
                model.requirements.append(requirement)
            for grant in parsed.get("access_grants", []):
                if not isinstance(grant, dict) or not grant.get("name"):
                    continue
                requirement_key = ("permission", f"{source_key}:access grant {grant['name']}")
                if requirement_key in recorded_project_requirements:
                    continue
                recorded_project_requirements.add(requirement_key)
                requirement = SemanticRequirementIR(
                    object_type="permission",
                    name=f"access grant {grant['name']}",
                    support_outcome="manual",
                    reason=(
                        "Looker access grants depend on user-attribute values and exact grant "
                        "placement. Map and validate the equivalent Omni access control before "
                        "emitting permission YAML."
                    ),
                    target_file_hint="model",
                    dependencies=_user_attribute_references(grant),
                    config={"access_grant": grant},
                )
                _stamp_requirement(requirement, metadata)
                model.requirements.append(requirement)
            for user_attribute in _user_attribute_references(parsed):
                requirement_key = ("user_attribute", f"{source_key}:user attribute {user_attribute}")
                if requirement_key in recorded_project_requirements:
                    continue
                recorded_project_requirements.add(requirement_key)
                requirement = SemanticRequirementIR(
                    object_type="user_attribute",
                    name=f"user attribute {user_attribute}",
                    support_outcome="manual",
                    reason=(
                        "Looker user attributes are admin-managed identity inputs. Confirm the "
                        "target Omni attribute, values, defaults, and assignments before migration."
                    ),
                    target_file_hint="model",
                    dependencies=[user_attribute],
                    config={"user_attribute": user_attribute},
                )
                _stamp_requirement(requirement, metadata)
                model.requirements.append(requirement)
            for v in parsed.get("views", []):
                if str(v.get("name") or "").startswith("+"):
                    requirement = _refinement_requirement(v)
                    _stamp_requirement(requirement, metadata)
                    model.requirements.append(requirement)
                    continue
                if str(v.get("name") or "") in emitted_views:
                    requirement = SemanticRequirementIR(
                        object_type="lineage",
                        name=f"duplicate view {v.get('name')}",
                        support_outcome="manual",
                        reason="The selected LookML closure contains duplicate view definitions; no later definition was allowed to overwrite the first.",
                        target_file_hint=f"{v.get('name')}.view",
                        dependencies=[source_key],
                    )
                    _stamp_requirement(requirement, metadata)
                    model.requirements.append(requirement)
                    continue
                requirement_start = len(model.requirements)
                view = _view(v, ctx.default_schema, model.requirements)
                view.connection.source_connection_name = file_connection
                _stamp_view(view, model.requirements[requirement_start:], metadata)
                model.views.append(view)
                emitted_views.add(view.name)
            explores.extend((item, metadata) for item in parsed.get("explores", []))

        # Resolve explores -> topics after all views are known (so PK lookups work).
        pk_by_view = {v.name: v.primary_key_field for v in model.views}
        for e, metadata in explores:
            requirement_start = len(model.requirements)
            topic, notes = _explore(e, pk_by_view, model.requirements)
            _stamp_topic(topic, model.requirements[requirement_start:], metadata)
            model.topics.append(topic)
            model.untranslatable.extend(notes)

        return MigrationBundle(
            source="looker",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
            acquisition=AcquisitionEvidenceIR(
                contract_version="looker.evidence.v1",
                mode=acquisition_mode,
                project_ids=sorted(project_ids or []),
                dashboard_ids=sorted(
                    item.native_source_id for item in dashboards if item.native_source_id
                ),
                look_ids=look_ids,
                query_ids=query_ids,
                source_files=sorted([*closure.required_files, *closure.unrelated_files]),
                required_files=closure.required_files,
                unrelated_files=closure.unrelated_files,
                dependencies=closure.dependencies,
                saved_look_coverage=saved_look_status,
                dependency_closure_status=closure.status,
                source_query_validation_status="not_evaluated",
                diagnostics=[
                    *[f"Unresolved query tile: {item}" for item in unresolved],
                    *closure.diagnostics,
                ],
            ),
            model=model,
            dashboards=dashboards,
        )

    def _extract_api(self, inp: ApiInput, ctx: ExtractCtx) -> MigrationBundle:
        snapshot = inp.auth.get("snapshot")
        if snapshot is None:
            client_id = str(inp.auth.get("client_id") or "").strip()
            client_secret = str(inp.auth.get("client_secret") or "").strip()
            if not client_id or not client_secret:
                raise ValueError("Looker API extraction requires client_id and client_secret")

            requested_projects = (
                ctx.scope.get("project_ids")
                or ctx.scope.get("project_id")
                or inp.auth.get("project_id")
                or []
            )
            if isinstance(requested_projects, str):
                project_ids = [requested_projects]
            elif isinstance(requested_projects, list):
                project_ids = [str(item) for item in requested_projects if str(item).strip()]
            else:
                project_ids = []

            requested_dashboards = (
                ctx.scope.get("dashboard_ids")
                or ctx.scope.get("selected_dashboard_ids")
                or []
            )
            if isinstance(requested_dashboards, str):
                dashboard_ids = [requested_dashboards]
            elif isinstance(requested_dashboards, list):
                dashboard_ids = [str(item) for item in requested_dashboards if str(item).strip()]
            else:
                dashboard_ids = []

            pairs = _compiled_explore_pairs(
                ctx.scope.get("explore_pairs") or ctx.scope.get("selected_explores") or []
            )
            single_model = str(ctx.scope.get("model") or "").strip()
            single_explore = str(ctx.scope.get("explore") or "").strip()
            if single_model and single_explore:
                pairs.append((single_model, single_explore))

            api = LookerApi(
                base_url=inp.base_url,
                client_id=client_id,
                client_secret=client_secret,
            )
            try:
                snapshot = api.compiled_evidence_snapshot(
                    project_ids=project_ids,
                    explore_pairs=list(dict.fromkeys(pairs)),
                    dashboard_ids=dashboard_ids,
                )
            finally:
                api.close()
        if not isinstance(snapshot, dict):
            raise ValueError("Looker compiled API snapshot must contain one object")
        return _build_compiled_api_bundle(snapshot, ctx)

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
from pathlib import PurePosixPath
from pathlib import Path
from tempfile import TemporaryDirectory

import lkml
import yaml

from omni_migrator.core.contracts import ApiInput, ExtractCtx, ExtractorInput, FileInput
from omni_migrator.deterministic.formats import map_value_format
from omni_migrator.deterministic.sql_cleanup import clean_sql
from omni_migrator.extractors.looker.api import LookerApi, fetch_lookml_files
from omni_migrator.extractors.looker.closure import analyze_looker_dependency_closure
from omni_migrator.extractors.looker.dashboard import translate_looker_dashboard, translate_looker_dashboard_lookml
from omni_migrator.ir.schema import (
    AcquisitionEvidenceIR,
    FieldIR,
    JoinIR,
    MigrationBundle,
    ModelIR,
    Provenance,
    SemanticRequirementIR,
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


def _yes(v) -> bool:
    return str(v).lower() == "yes"


def _split_table(sql_table_name: str | None, default_schema: str | None):
    if not sql_table_name:
        return None, None
    parts = sql_table_name.strip().split(".")
    if len(parts) >= 2:
        return parts[-2], parts[-1]
    return default_schema, parts[0]


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

    fields: list[FieldIR] = []
    for d in v.get("dimensions", []):
        fields.append(_dimension(d))
    for g in v.get("dimension_groups", []):
        fields.append(_dimension_group(g))
    for parameter in v.get("parameters", []):
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
) -> tuple[JoinIR | None, UntranslatableNote | None]:
    """Map one LookML `join` to a JoinIR.

    `join_to_view` is the joined view (honoring `from`/`view_name` aliases). `join_from_view`
    is inferred from `sql_on` (the referenced view that isn't the join target — handles
    snowflake joins), falling back to the explore's base view.
    """
    join_to = join.get("view_name") or join.get("from") or join["name"]
    looker_type = (join.get("type") or "left_outer").lower()
    looker_rel = (join.get("relationship") or "many_to_one").lower()

    note = None
    if looker_type == "cross":
        note = UntranslatableNote(
            object=f"join {join['name']}",
            reason="Looker `cross` join has no Omni equivalent; emitted as inner — review.",
            severity="warning",
        )

    on_sql = join.get("sql_on")
    if not on_sql:
        fk = join.get("foreign_key")
        if fk:
            target_pk = pk_by_view.get(join_to) or "id"
            on_sql = f"${{{base_view}.{fk}}} = ${{{join_to}.{target_pk}}}"
        else:
            return None, UntranslatableNote(
                object=f"join {join['name']}",
                reason="Join has neither `sql_on` nor `foreign_key`; cannot derive condition.",
                severity="blocker",
            )

    refs = {m for m in _VIEW_REF.findall(on_sql)} - {join_to}
    join_from = base_view if base_view in refs or not refs else sorted(refs)[0]

    return (
        JoinIR(
            join_from_view=join_from,
            join_to_view=join_to,
            join_type=_JOIN_TYPE.get(looker_type, "always_left"),
            relationship_type=_RELATIONSHIP.get(looker_rel, "many_to_one"),
            on_sql=on_sql,
        ),
        note,
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
    for j in e.get("joins", []):
        join_ir, note = _join(base_view, j, pk_by_view)
        if join_ir:
            joins.append(join_ir)
        if note:
            notes.append(note)
    if "extends" in e or "extends__all" in e:
        requirements.append(SemanticRequirementIR(
            object_type="extension",
            name=f"explore {e['name']}",
            support_outcome="decision_required",
            reason="LookML Explore inheritance must be flattened or preserved by an explicit reviewer decision.",
            target_file_hint=f"{e['name']}.topic",
            config={"extends": e.get("extends") or e.get("extends__all")},
        ))
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
    ) -> MigrationBundle:
        model = ModelIR()
        artifacts: list[str] = []
        explores: list[dict] = []
        dashboard_blocks: list[dict] = []
        saved_looks: dict[str, dict] = {}
        connection_name: str | None = None
        for path in inp.paths:
            path = Path(path)
            artifacts.append(str(path))
            look_rows = _manual_saved_looks(path)
            if look_rows:
                for look in look_rows:
                    look_id = str(look["id"])
                    if look_id in saved_looks:
                        raise ValueError(f"Duplicate saved Look id {look_id} in manual evidence")
                    saved_looks[look_id] = look
                continue
            if path.name.endswith(".dashboard.lookml"):
                parsed_dashboards = yaml.safe_load(path.read_text()) or []
                if isinstance(parsed_dashboards, dict):
                    parsed_dashboards = [parsed_dashboards]
                dashboard_blocks.extend(item for item in parsed_dashboards if isinstance(item, dict))
                continue
            with path.open() as fh:
                parsed = lkml.load(fh)
            # model files declare `connection: "<name>"`; capture for dialect resolution
            if parsed.get("connection"):
                connection_name = parsed["connection"]
            for v in parsed.get("views", []):
                model.views.append(_view(v, ctx.default_schema, model.requirements))
            explores.extend(parsed.get("explores", []))

        # stamp the LookML connection name on each view (dialect resolved later via API)
        if connection_name:
            for v in model.views:
                v.connection.source_connection_name = connection_name

        # Resolve explores -> topics after all views are known (so PK lookups work).
        pk_by_view = {v.name: v.primary_key_field for v in model.views}
        for e in explores:
            topic, notes = _explore(e, pk_by_view, model.requirements)
            model.topics.append(topic)
            model.untranslatable.extend(notes)

        dashboards = [
            translate_looker_dashboard_lookml(item, saved_looks)
            for item in dashboard_blocks
        ]
        saved_look_status, look_ids, query_ids, unresolved = _saved_look_coverage(dashboards)
        closure = analyze_looker_dependency_closure(
            [Path(item) for item in inp.paths],
            dashboards,
            project_ids=project_ids,
            source_root=source_root,
        )

        return MigrationBundle(
            source="looker",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
            acquisition=AcquisitionEvidenceIR(
                contract_version="looker.evidence.v1",
                mode=acquisition_mode,
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
        client_id = str(inp.auth.get("client_id") or "").strip()
        client_secret = str(inp.auth.get("client_secret") or "").strip()
        if not client_id or not client_secret:
            raise ValueError("Looker API extraction requires client_id and client_secret")
        api = LookerApi(base_url=inp.base_url, client_id=client_id, client_secret=client_secret)
        try:
            requested_projects = ctx.scope.get("project_ids") or ctx.scope.get("project_id") or inp.auth.get("project_id")
            if isinstance(requested_projects, str):
                project_ids = [requested_projects]
            elif isinstance(requested_projects, list):
                project_ids = [str(item) for item in requested_projects if str(item).strip()]
            else:
                projects = api.list_projects()
                project_ids = [str(item.get("id")) for item in projects if item.get("id")]
                if len(project_ids) != 1:
                    raise ValueError("Select one or more Looker project IDs before semantic extraction")

            requested_dashboards = ctx.scope.get("dashboard_ids") or ctx.scope.get("selected_dashboard_ids") or []
            if isinstance(requested_dashboards, str):
                dashboard_ids = [requested_dashboards]
            elif isinstance(requested_dashboards, list):
                dashboard_ids = [str(item) for item in requested_dashboards if str(item).strip()]
            else:
                dashboard_ids = []

            with TemporaryDirectory(prefix="omni-migrator-looker-") as root_text:
                root = Path(root_text)
                paths: list[Path] = []
                for project_id in project_ids:
                    for source_path, content in fetch_lookml_files(api, project_id).items():
                        relative = PurePosixPath(source_path.replace("\\", "/"))
                        if relative.is_absolute() or ".." in relative.parts:
                            raise ValueError(f"Looker project returned an unsafe file path: {source_path}")
                        target = root / project_id / Path(*relative.parts)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(content)
                        paths.append(target)
                if not paths:
                    raise ValueError("The selected Looker project returned no LookML files")
                bundle = self._extract_files(
                    FileInput(paths=paths),
                    ctx,
                    acquisition_mode="api",
                    project_ids=project_ids,
                    source_root=root,
                )
                resolve_dialects(bundle.model, api.connection_dialects())
                dashboard_payloads = [api.get_dashboard_complete(item) for item in dashboard_ids]
                bundle.dashboards.extend(translate_looker_dashboard(item) for item in dashboard_payloads)
                bundle.provenance.source_artifact = ", ".join(f"Looker project {item}" for item in project_ids)
                saved_look_status, look_ids, query_ids, unresolved = _saved_look_coverage(bundle.dashboards)
                closure = analyze_looker_dependency_closure(
                    paths,
                    bundle.dashboards,
                    project_ids=project_ids,
                    source_root=root,
                )
                bundle.acquisition = AcquisitionEvidenceIR(
                    contract_version="looker.evidence.v1",
                    mode="api",
                    project_ids=sorted(project_ids),
                    dashboard_ids=sorted(dashboard_ids),
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
                )
                return bundle
        finally:
            api.close()

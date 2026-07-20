"""Looker (LookML) extractor: .lkml files -> canonical IR.

Parsing is delegated to `lkml` (the standard pure-Python LookML parser) — we never
hand-roll LookML parsing. This module owns only the *mapping* (plan §6.3, Appendix A.3):
LookML view/dimension/measure/dimension_group -> ViewIR/FieldIR.

Out of scope for this first slice (flagged as untranslatable, not silently dropped):
explores->topics with joins, liquid, extends/refinements, sets, native derived tables.
"""

from __future__ import annotations

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
from omni_migrator.extractors.looker.dashboard import translate_looker_dashboard, translate_looker_dashboard_lookml
from omni_migrator.ir.schema import (
    FieldIR,
    JoinIR,
    MigrationBundle,
    ModelIR,
    Provenance,
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


def _measure(m: dict) -> tuple[FieldIR | None, UntranslatableNote | None]:
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
    filters = None
    raw_filters = m.get("filters") or m.get("filters__all")
    if raw_filters:
        filters = UntranslatableNote(
            object=f"measure {m['name']}.filters",
            reason="Filtered-measure conditions need review/translation.",
            severity="info",
            hint=str(raw_filters),
        )
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
    )
    return field, filters


def _view(v: dict, default_schema: str | None) -> ViewIR:
    notes: list[UntranslatableNote] = []
    if "extends" in v or "extends__all" in v:
        notes.append(UntranslatableNote(object=f"view {v['name']}", reason="`extends` not supported.", severity="warning"))
    if "sets" in v:
        notes.append(UntranslatableNote(object=f"view {v['name']}", reason="`set` belongs in the Omni model file; migrate manually.", severity="info"))

    schema_name = table = None
    sql = None
    if "sql_table_name" in v:
        schema_name, table = _split_table(v["sql_table_name"], default_schema)
    derived = v.get("derived_table")
    if derived and "sql" in derived:
        sql = derived["sql"]
    elif derived:
        notes.append(UntranslatableNote(object=f"view {v['name']}", reason="Native/PDT derived table not supported; needs manual SQL.", severity="blocker"))

    fields: list[FieldIR] = []
    for d in v.get("dimensions", []):
        fields.append(_dimension(d))
    for g in v.get("dimension_groups", []):
        fields.append(_dimension_group(g))
    for m in v.get("measures", []):
        field, note = _measure(m)
        if field:
            fields.append(field)
        if note:
            notes.append(note)

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


def _explore(e: dict, pk_by_view: dict[str, str | None]) -> tuple[TopicIR, list[UntranslatableNote]]:
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
        notes.append(
            UntranslatableNote(
                object=f"explore {e['name']}", reason="`extends` on explores not supported.", severity="warning"
            )
        )
    topic = TopicIR(
        name=e["name"],
        base_view=base_view,
        label=e.get("label"),
        description=e.get("description"),
        joins=joins,
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


class LookerExtractor:
    source = "looker"

    def detect(self, inp: ExtractorInput) -> bool:
        return isinstance(inp, ApiInput) or isinstance(inp, FileInput) and any(
            str(p).endswith((".lkml", ".lookml")) for p in inp.paths
        )

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx | None = None) -> MigrationBundle:
        ctx = ctx or ExtractCtx()
        if isinstance(inp, ApiInput):
            return self._extract_api(inp, ctx)
        if not isinstance(inp, FileInput):
            raise TypeError("LookerExtractor supports LookML FileInput or scoped Looker ApiInput.")
        return self._extract_files(inp, ctx)

    def _extract_files(self, inp: FileInput, ctx: ExtractCtx) -> MigrationBundle:
        model = ModelIR()
        artifacts: list[str] = []
        explores: list[dict] = []
        dashboards = []
        connection_name: str | None = None
        for path in inp.paths:
            path = Path(path)
            artifacts.append(str(path))
            if path.name.endswith(".dashboard.lookml"):
                parsed_dashboards = yaml.safe_load(path.read_text()) or []
                if isinstance(parsed_dashboards, dict):
                    parsed_dashboards = [parsed_dashboards]
                dashboards.extend(
                    translate_looker_dashboard_lookml(item)
                    for item in parsed_dashboards
                    if isinstance(item, dict)
                )
                continue
            with path.open() as fh:
                parsed = lkml.load(fh)
            # model files declare `connection: "<name>"`; capture for dialect resolution
            if parsed.get("connection"):
                connection_name = parsed["connection"]
            for v in parsed.get("views", []):
                model.views.append(_view(v, ctx.default_schema))
            explores.extend(parsed.get("explores", []))

        # stamp the LookML connection name on each view (dialect resolved later via API)
        if connection_name:
            for v in model.views:
                v.connection.source_connection_name = connection_name

        # Resolve explores -> topics after all views are known (so PK lookups work).
        pk_by_view = {v.name: v.primary_key_field for v in model.views}
        for e in explores:
            topic, notes = _explore(e, pk_by_view)
            model.topics.append(topic)
            model.untranslatable.extend(notes)

        return MigrationBundle(
            source="looker",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
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
                bundle = self._extract_files(FileInput(paths=paths), ctx)
                resolve_dialects(bundle.model, api.connection_dialects())
                bundle.dashboards.extend(translate_looker_dashboard(api.get_dashboard(item)) for item in dashboard_ids)
                bundle.provenance.source_artifact = ", ".join(f"Looker project {item}" for item in project_ids)
                return bundle
        finally:
            api.close()

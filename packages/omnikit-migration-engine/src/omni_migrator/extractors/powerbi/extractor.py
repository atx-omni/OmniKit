"""Power BI extractor: `.pbix` (VertiPaq data model) -> canonical IR.

Dashboard translation (Report/Layout JSON -> DashboardIR) lives in `dashboard.py`; this module
also calls its `attach_visual_aggregate_hints` to surface implicit visual aggregates onto the
model's views (2026-07-10, mirroring the Metabase dashboard-SQL-hint fix).
Mapping follows plan §6.2:

- The binary `DataModel` part is opened via `pbixray` (wraps the VertiPaq decoder) —
  we never hand-roll that format. See https://github.com/Hugoberry/pbixray.
- `schema` rows -> ViewIR/FieldIR (physical columns -> dimensions; type from the
  normalized `PandasDataType` column).
- `dax_columns` (calculated columns) have no deterministic SQL equivalent (row-context
  DAX) -> always `untranslatable`, DAX text as the AI hint.
- `dax_measures` -> `deterministic.dax_translate.translate_measure`: only a single
  clean aggregate wrapper over a same-table column translates deterministically;
  everything else (CALCULATE, time intelligence, cross-table refs, iterators) is
  flagged for AI translation, never guessed (snowparser's AI-scoping lesson, §12.2).
- `dax_tables` (calculated tables, e.g. DAX date tables) have no deterministic source
  SQL -> noted at the model level, not emitted as a broken view.
- `relationships` (`From` = many side, `To` = one side per pbixray's `Cardinality`
  column) -> one `TopicIR` per fact (many-side) table, `JoinIR` per active relationship.
- `power_query` (M) is scanned for a known connector call to infer the dialect
  (best-effort, one dialect for the whole file — see `_dialect_from_m`).

The extraction logic (`_build_bundle`) takes any object exposing pbixray's
`.schema` / `.dax_measures` / `.dax_columns` / `.dax_tables` / `.relationships` /
`.power_query` DataFrame properties, so it's unit-testable offline without a real
`.pbix` binary (see `tests/test_powerbi.py`).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from omni_migrator.core.contracts import ExtractCtx, ExtractorInput, FileInput
from omni_migrator.deterministic.dax_translate import translate_measure
from omni_migrator.ir.schema import (
    ConnectionRef,
    Dialect,
    FieldIR,
    JoinIR,
    MigrationBundle,
    ModelIR,
    Provenance,
    TopicIR,
    UntranslatableNote,
    ViewIR,
)

_PANDAS_TYPE_MAP = {
    "string": "string",
    "Int64": "number",
    "Float64": "number",
    "decimal.Decimal": "number",
    "datetime64[ns]": "timestamp",
    "bool": "boolean",
    "bytes": "string",
}

# M connector call -> IR dialect (best-effort; the whole file gets one dialect).
_DIALECT_PATTERNS: list[tuple[re.Pattern, Dialect]] = [
    (re.compile(r"\bSnowflake\.Databases\b"), "snowflake"),
    (re.compile(r"\bGoogleBigQuery\.Database\b"), "bigquery"),
    (re.compile(r"\bAmazonRedshift\.Database\b"), "redshift"),
    (re.compile(r"\bPostgreSQL\.Database\b"), "postgres"),
    (re.compile(r"\bDatabricks\.Catalogs\b"), "databricks"),
    (re.compile(r"\bMySQL\.Database\b"), "mysql"),
    (re.compile(r"\bSql\.Database(s)?\b"), "other"),  # SQL Server has no IR dialect yet
]


def _clean(v: Any) -> Any:
    """NaN/None -> None (avoids importing pandas just to call `pd.isna`)."""
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    return v


def _records(df) -> list[dict]:
    if df is None or len(df) == 0:
        return []
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dict("records")]


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", text.strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _omni_data_type(pandas_type: str | None) -> str:
    return _PANDAS_TYPE_MAP.get(pandas_type or "", "string")


def _dialect_from_m(model) -> Dialect:
    try:
        rows = _records(model.power_query)
    except Exception:  # noqa: BLE001 - absent/unparseable M shouldn't fail extraction
        rows = []
    text = " ".join(str(r.get("Expression") or "") for r in rows)
    for pattern, dialect in _DIALECT_PATTERNS:
        if pattern.search(text):
            return dialect
    return "other"


def _build_views(
    model, dialect: Dialect, calc_tables: set[str]
) -> tuple[dict[str, ViewIR], set[tuple[str, str]]]:
    calc_columns = {(r["TableName"], r["ColumnName"]) for r in _records(model.dax_columns)}
    views: dict[str, ViewIR] = {}
    for row in _records(model.schema):
        table, column = row.get("TableName"), row.get("ColumnName")
        if not table or not column or table in calc_tables:
            continue  # calculated tables have no physical source_table (handled as a note)
        view = views.setdefault(
            _snake(table),
            ViewIR(
                name=_snake(table), source_table=table,
                connection=ConnectionRef(source_connection_name="power_query", dialect=dialect),
            ),
        )
        if (table, column) in calc_columns:
            continue  # calculated columns are handled separately (always AI)
        view.fields.append(
            FieldIR(
                name=_snake(column), source_name=column, kind="dimension",
                data_type=_omni_data_type(row.get("PandasDataType")),
                sql=column,  # bare column name — Omni has no ${TABLE} token
            )
        )
    return views, calc_columns


def _add_calculated_columns(views: dict[str, ViewIR], model) -> None:
    for row in _records(model.dax_columns):
        table, column, expr = row.get("TableName"), row.get("ColumnName"), row.get("Expression") or ""
        view = views.get(_snake(table or ""))
        if view is None:
            continue
        view.untranslatable.append(
            UntranslatableNote(
                object=f"calculated column {table}[{column}]",
                reason="DAX calculated column (row-context); no deterministic Omni equivalent.",
                severity="warning",
                hint=expr,
            )
        )


def _add_measures(views: dict[str, ViewIR], model) -> None:
    for row in _records(model.dax_measures):
        table, name, expr = row.get("TableName"), row.get("Name"), row.get("Expression") or ""
        view = views.get(_snake(table or ""))
        if view is None:
            continue
        sql, aggregate, reason = translate_measure(expr, home_table=table)
        if reason:
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"measure {table}[{name}]", reason=reason, severity="warning", hint=expr,
                )
            )
            continue
        view.fields.append(
            FieldIR(
                name=_snake(name), source_name=name, kind="measure", data_type="number",
                sql=sql, aggregate=aggregate,
                description=row.get("Description") or None,
                group_label=row.get("DisplayFolder") or None,
            )
        )


def _calculated_table_notes(model) -> list[UntranslatableNote]:
    notes = []
    for row in _records(model.dax_tables):
        table, expr = row.get("TableName"), row.get("Expression") or ""
        notes.append(
            UntranslatableNote(
                object=f"calculated table {table}", severity="warning", hint=expr,
                reason="DAX table expression; no deterministic source SQL — not emitted as a view.",
            )
        )
    return notes


def _build_topics(views: dict[str, ViewIR], model) -> list[TopicIR]:
    topics: dict[str, TopicIR] = {}
    for row in _records(model.relationships):
        from_table, from_col = row.get("FromTableName"), row.get("FromColumnName")
        to_table, to_col = row.get("ToTableName"), row.get("ToColumnName")
        if not all((from_table, from_col, to_table, to_col)):
            continue
        from_view, to_view = _snake(from_table), _snake(to_table)
        if from_view not in views or to_view not in views:
            continue
        if not row.get("IsActive", True):
            views[from_view].untranslatable.append(
                UntranslatableNote(
                    object=f"relationship {from_table}->{to_table}", severity="info",
                    reason="Inactive relationship (USERELATIONSHIP); only the active path is emitted.",
                )
            )
            continue
        cardinality = row.get("Cardinality") or "M:1"
        from_card, to_card = cardinality.split(":") if ":" in cardinality else ("M", "1")
        if from_card == "M" and to_card == "M":
            relationship_type = "many_to_many"
        elif from_card == "M":
            relationship_type = "many_to_one"
        elif to_card == "M":
            relationship_type = "one_to_many"
        else:
            relationship_type = "one_to_one"

        topic = topics.setdefault(from_view, TopicIR(name=from_view, base_view=from_view))
        topic.joins.append(
            JoinIR(
                join_from_view=from_view, join_to_view=to_view,
                relationship_type=relationship_type,
                on_sql=f"${{{from_view}.{_snake(from_col)}}} = ${{{to_view}.{_snake(to_col)}}}",
            )
        )
    return list(topics.values())


class PowerBIExtractor:
    source = "powerbi"

    def detect(self, inp: ExtractorInput) -> bool:
        return isinstance(inp, FileInput) and any(str(p).endswith(".pbix") for p in inp.paths)

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx | None = None) -> MigrationBundle:
        ctx = ctx or ExtractCtx()
        if not isinstance(inp, FileInput):
            raise TypeError("PowerBIExtractor supports FileInput (.pbix).")
        from pbixray import PBIXRay  # imported lazily: heavy optional dependency

        model = ModelIR()
        dashboards = []
        artifacts: list[str] = []
        for path in inp.paths:
            path = Path(path)
            artifacts.append(str(path))
            pbix = PBIXRay(str(path))
            try:
                bundle = _build_bundle(pbix, default_schema=ctx.default_schema)
            finally:
                pbix.close()
            # Surface implicit visual aggregates (Report/Layout, the same .pbix this model came
            # from) onto the views they touch — real business logic (e.g. a report visual with
            # "drag sale_price, pick Sum") the deterministic model pass can't see on its own.
            # Without this it only ever reached the dashboard-migration AI's seed prompt, never
            # the modeling AI's — mirrors the Metabase fix for ad-hoc dashboard SQL. Best-effort:
            # not every .pbix has a saved Report/Layout part (e.g. some service-published/CI
            # artifacts strip it), so absence is not an error.
            try:
                from omni_migrator.extractors.powerbi.dashboard import (
                    attach_visual_aggregate_hints,
                    load_layout,
                )

                layout = load_layout(path)
            except (KeyError, ValueError):
                layout = None
            if layout is not None:
                attach_visual_aggregate_hints(layout, {v.name: v for v in bundle.views})
                from omni_migrator.extractors.powerbi.dashboard import translate_powerbi_layout

                dashboards.extend(translate_powerbi_layout(layout, source_url=path.name))
            model.views.extend(bundle.views)
            model.topics.extend(bundle.topics)
            model.untranslatable.extend(bundle.untranslatable)
        return MigrationBundle(
            source="powerbi",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
            model=model,
            dashboards=dashboards,
        )


class _PartialModel:
    """Plain container so `_build_bundle`'s result composes into `ModelIR` above."""

    def __init__(self, views, topics, untranslatable):
        self.views = views
        self.topics = topics
        self.untranslatable = untranslatable


def _build_bundle(model, default_schema: str | None = None) -> _PartialModel:
    """Pure transform: a pbixray-shaped `model` -> (views, topics, notes).

    Takes any object exposing pbixray's `.schema` / `.dax_measures` / `.dax_columns` /
    `.dax_tables` / `.relationships` / `.power_query` DataFrame properties — real
    `PBIXRay` or a duck-typed test double (`default_schema` is accepted for
    interface symmetry with the other extractors; Power BI tables aren't schema-qualified).
    """
    del default_schema
    dialect = _dialect_from_m(model)
    calc_tables = {r["TableName"] for r in _records(model.dax_tables)}
    views, _calc_columns = _build_views(model, dialect, calc_tables)
    _add_calculated_columns(views, model)
    _add_measures(views, model)
    topics = _build_topics(views, model)
    notes = _calculated_table_notes(model)
    return _PartialModel(list(views.values()), topics, notes)

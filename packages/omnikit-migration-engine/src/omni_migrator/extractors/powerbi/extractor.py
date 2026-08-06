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
import zipfile
from pathlib import Path
from typing import Any

from omni_migrator.core.archive_safety import validate_zip_archive
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
    SemanticRequirementIR,
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

_DAX_FILTER_CONTEXT_FUNCTIONS = {
    "ALL", "ALLEXCEPT", "ALLNOBLANKROW", "ALLSELECTED", "CALCULATE", "CALCULATETABLE",
    "CROSSFILTER", "FILTER", "ISFILTERED", "ISCROSSFILTERED", "KEEPFILTERS", "RELATED",
    "RELATEDTABLE", "REMOVEFILTERS", "SELECTEDVALUE", "TREATAS", "USERELATIONSHIP",
}
_MAX_POWER_BI_ARTIFACT_BYTES = 150 * 1024 * 1024


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


def _required_records(model, attribute: str) -> list[dict]:
    """Read a pbixray evidence frame and fail closed when it cannot be inspected."""
    try:
        return _records(getattr(model, attribute))
    except Exception as exc:  # noqa: BLE001 - normalize third-party parser failures
        raise ValueError(
            f"Power BI evidence frame '{attribute}' is unavailable or unreadable; "
            "migration cannot claim complete source coverage."
        ) from exc


def _optional_records(model, attribute: str) -> list[dict]:
    """Read an optional pbixray enrichment frame without hiding parse failures."""
    try:
        frame = getattr(model, attribute)
    except AttributeError:
        return []
    try:
        return _records(frame)
    except Exception as exc:  # noqa: BLE001 - normalize third-party parser failures
        raise ValueError(
            f"Power BI evidence frame '{attribute}' is unreadable; "
            "migration cannot safely use its partial contents."
        ) from exc


_OPTIONAL_EVIDENCE_FRAMES = (
    "tmschema_tables",
    "tmschema_columns",
    "rls",
    "tmschema_role_memberships",
    "tmschema_calculation_items",
    "tmschema_calculation_groups",
    "tmschema_levels",
    "tmschema_hierarchies",
    "tmschema_partitions",
)


def _missing_optional_frames(model) -> list[str]:
    missing: list[str] = []
    for attribute in _OPTIONAL_EVIDENCE_FRAMES:
        try:
            getattr(model, attribute)
        except AttributeError:
            missing.append(attribute)
    return missing


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", text.strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


def _source_id(kind: str, *parts: Any, explicit: Any = None) -> str:
    if explicit is not None and str(explicit).strip():
        return f"powerbi:{kind}:{str(explicit).strip()}"
    logical = ":".join(_snake(str(part)) for part in parts if part is not None and str(part).strip())
    return f"powerbi:logical:{kind}:{logical or 'unknown'}"


def _dax_lexical_evidence(expression: str, home_table: str | None = None) -> dict[str, list[str]]:
    """Return bounded lexical evidence only; this is deliberately not a DAX parser."""
    cleaned = re.sub(r"/\*.*?\*/|//[^\n]*", " ", expression or "", flags=re.DOTALL)
    cleaned = re.sub(r'"(?:""|[^"])*"', " ", cleaned)
    dependencies: list[str] = []
    qualified_spans: list[tuple[int, int]] = []
    qualified = re.compile(r"(?:'((?:''|[^'])+)'|([A-Za-z_][A-Za-z0-9_ ]*))\s*\[\s*([^\]]+?)\s*\]")
    for match in qualified.finditer(cleaned):
        table = (match.group(1) or match.group(2) or "").replace("''", "'").strip()
        field = (match.group(3) or "").strip()
        if table and field:
            dependencies.append(f"{table}.{field}")
        qualified_spans.append(match.span())
    for match in re.finditer(r"\[\s*([^\]]+?)\s*\]", cleaned):
        if any(start <= match.start() < end for start, end in qualified_spans):
            continue
        field = (match.group(1) or "").strip()
        if field:
            dependencies.append(f"{home_table}.{field}" if home_table else field)
    functions = {
        match.group(1).upper()
        for match in re.finditer(r"\b([A-Za-z][A-Za-z0-9_]*)\s*\(", cleaned)
        if match.group(1).upper() in _DAX_FILTER_CONTEXT_FUNCTIONS
    }
    return {
        "dependencies": list(dict.fromkeys(dependencies)),
        "filter_context_functions": sorted(functions),
    }


def _omni_data_type(pandas_type: str | None) -> str:
    return _PANDAS_TYPE_MAP.get(pandas_type or "", "string")


def _dialect_from_m(model) -> Dialect:
    rows = _required_records(model, "power_query")
    text = " ".join(str(r.get("Expression") or "") for r in rows)
    for pattern, dialect in _DIALECT_PATTERNS:
        if pattern.search(text):
            return dialect
    return "other"


def _build_views(
    model, dialect: Dialect, calc_tables: set[str]
) -> tuple[dict[str, ViewIR], set[tuple[str, str]]]:
    calc_columns = {
        (r["TableName"], r["ColumnName"])
        for r in _required_records(model, "dax_columns")
    }
    table_metadata = {
        row.get("Name"): row
        for row in _optional_records(model, "tmschema_tables")
        if row.get("Name")
    }
    column_metadata = {
        (row.get("TableName"), row.get("Name")): row
        for row in _optional_records(model, "tmschema_columns")
        if row.get("TableName") and row.get("Name")
    }
    views: dict[str, ViewIR] = {}
    source_tables: dict[str, str] = {}
    field_names: dict[str, dict[str, str]] = {}
    for row in _required_records(model, "schema"):
        table, column = row.get("TableName"), row.get("ColumnName")
        if not table or not column:
            raise ValueError("Power BI schema evidence is truncated: table or column name is missing.")
        if table in calc_tables:
            continue  # calculated tables have no physical source_table (handled as a note)
        view_name = _snake(table)
        prior_table = source_tables.setdefault(view_name, table)
        if prior_table != table:
            raise ValueError(
                f"Power BI table names '{prior_table}' and '{table}' normalize to the same "
                f"Omni view name '{view_name}'. Resolve the collision before migration."
            )
        field_name = _snake(column)
        prior_column = field_names.setdefault(view_name, {}).setdefault(field_name, column)
        if prior_column != column:
            raise ValueError(
                f"Power BI columns '{prior_column}' and '{column}' in table '{table}' normalize "
                f"to the same Omni field name '{field_name}'. Resolve the collision before migration."
            )
        table_meta = table_metadata.get(table, {})
        column_meta = column_metadata.get((table, column), {})
        view = views.setdefault(
            view_name,
            ViewIR(
                source_id=_source_id("table", table, explicit=table_meta.get("ID")),
                source_locator=(
                    f"TMSCHEMA_TABLES[ID={table_meta['ID']}]"
                    if table_meta.get("ID") is not None else f"schema[TableName={table}] (logical identity)"
                ),
                name=view_name, source_table=table,
                connection=ConnectionRef(source_connection_name="power_query", dialect=dialect),
            ),
        )
        if (table, column) in calc_columns:
            continue  # calculated columns are handled separately (always AI)
        field = FieldIR(
                source_id=_source_id("column", table, column, explicit=column_meta.get("ID")),
                source_locator=(
                    f"TMSCHEMA_COLUMNS[ID={column_meta['ID']}]"
                    if column_meta.get("ID") is not None else f"schema[{table}.{column}] (logical identity)"
                ),
                name=field_name, source_name=column, kind="dimension",
                data_type=_omni_data_type(row.get("PandasDataType")),
                sql=column,  # bare column name — Omni has no ${TABLE} token
            )
        if row.get("PandasDataType") not in _PANDAS_TYPE_MAP:
            field.untranslatable.append(UntranslatableNote(
                object=f"column {table}[{column}]",
                severity="blocker",
                reason=(
                    f"Power BI type '{row.get('PandasDataType') or 'missing'}' has no verified "
                    "Omni type mapping. A string placeholder was retained for review only."
                ),
            ))
        view.fields.append(field)
    return views, calc_columns


def _add_calculated_columns(
    views: dict[str, ViewIR], model, requirements: list[SemanticRequirementIR]
) -> list[UntranslatableNote]:
    model_notes: list[UntranslatableNote] = []
    column_metadata = {
        (row.get("TableName"), row.get("Name")): row
        for row in _optional_records(model, "tmschema_columns")
        if row.get("TableName") and row.get("Name")
    }
    for row in _required_records(model, "dax_columns"):
        table, column, expr = row.get("TableName"), row.get("ColumnName"), row.get("Expression") or ""
        if not table or not column or not expr.strip():
            raise ValueError("Power BI calculated-column evidence is truncated.")
        view = views.get(_snake(table or ""))
        source_id = _source_id("calculated_column", table, column)
        evidence = _dax_lexical_evidence(expr, table)
        requirements.append(SemanticRequirementIR(
            source_id=source_id,
            source_locator=f"dax_columns[{table}.{column}]",
            object_type="dynamic_field",
            name=f"{table}.{column}",
            support_outcome="decision_required",
            reason=(
                "DAX row-context semantics require an explicitly reviewed Omni expression or an "
                "upstream transformation. AI output may propose code but cannot approve or deploy it."
            ),
            dependencies=evidence["dependencies"],
            config={
                "source_language": "DAX",
                "expression": expr,
                "filter_context_functions": evidence["filter_context_functions"],
                "review_only": True,
            },
        ))
        if view is None:
            model_notes.append(UntranslatableNote(
                object=f"calculated column {table}[{column}]",
                severity="blocker",
                hint=expr,
                reason="The calculated column's parent table was not recovered; no target field was emitted.",
            ))
            continue
        metadata = column_metadata.get((table, column), {})
        view.untranslatable.append(
            UntranslatableNote(
                object=f"calculated column {table}[{column}]",
                reason=(
                    "DAX calculated column uses row context; no deterministic Omni equivalent was emitted. "
                    f"Source ID {_source_id('column', table, column, explicit=metadata.get('ID'))}; "
                    f"lexical dependencies {evidence['dependencies'] or ['not detected']}; source-result validation is required."
                ),
                severity="blocker", hint=expr,
            )
        )
    return model_notes


def _add_measures(
    views: dict[str, ViewIR], model, requirements: list[SemanticRequirementIR]
) -> list[UntranslatableNote]:
    model_notes: list[UntranslatableNote] = []
    for row in _required_records(model, "dax_measures"):
        table, name, expr = row.get("TableName"), row.get("Name"), row.get("Expression") or ""
        if not table or not name or not expr.strip():
            raise ValueError("Power BI measure evidence is truncated.")
        view = views.get(_snake(table or ""))
        source_id = _source_id("measure", table, name)
        source_locator = f"dax_measures[{table}.{name}] (logical identity; no native measure ID exposed)"
        evidence = _dax_lexical_evidence(expr, table)
        sql, aggregate, reason = translate_measure(expr, home_table=table)
        if view is None:
            model_notes.append(UntranslatableNote(
                object=f"measure {table}[{name}]",
                severity="blocker",
                hint=expr,
                reason="The measure's home table was not recovered; no target measure was emitted.",
            ))
            requirements.append(SemanticRequirementIR(
                source_id=source_id,
                source_locator=source_locator,
                object_type="dynamic_field",
                name=f"{table}.{name}",
                support_outcome="manual",
                reason="The home table must be recovered before this DAX measure can be reviewed.",
                dependencies=evidence["dependencies"],
                config={"source_language": "DAX", "expression": expr, "review_only": True},
            ))
            continue
        if reason:
            requirements.append(SemanticRequirementIR(
                source_id=source_id,
                source_locator=source_locator,
                object_type="dynamic_field",
                name=f"{table}.{name}",
                support_outcome="decision_required",
                reason=(
                    "This DAX measure is outside the deterministic translator. Any AI translation "
                    "is a review-only proposal and requires source-result parity validation."
                ),
                dependencies=evidence["dependencies"],
                config={
                    "source_language": "DAX",
                    "expression": expr,
                    "filter_context_functions": evidence["filter_context_functions"],
                    "review_only": True,
                },
            ))
            view.untranslatable.append(
                UntranslatableNote(
                    object=f"measure {table}[{name}]", reason=(
                        f"{reason} Source ID {source_id}; lexical dependencies "
                        f"{evidence['dependencies'] or ['not detected']}; filter-context-sensitive functions "
                        f"{evidence['filter_context_functions'] or ['not detected']}. "
                        "This lexical evidence is not an AST or parity claim; source-result validation is required."
                    ), severity="blocker", hint=expr,
                )
            )
            continue
        view.fields.append(
            FieldIR(
                source_id=source_id, source_locator=source_locator,
                name=_snake(name), source_name=name, kind="measure", data_type="number",
                sql=sql, aggregate=aggregate,
                description=row.get("Description") or None,
                group_label=row.get("DisplayFolder") or None,
            )
        )
    return model_notes


def _calculated_table_notes(model) -> list[UntranslatableNote]:
    notes = []
    for row in _required_records(model, "dax_tables"):
        table, expr = row.get("TableName"), row.get("Expression") or ""
        if not table or not expr.strip():
            raise ValueError("Power BI calculated-table evidence is truncated.")
        notes.append(
            UntranslatableNote(
                object=f"calculated table {table}", severity="blocker", hint=expr,
                reason=(
                    "DAX table expression has no deterministic source SQL and was not emitted as a view. "
                    f"Source ID {_source_id('calculated_table', table)}; source-result validation is required."
                ),
            )
        )
    return notes


def _power_query_requirements(
    model, views: dict[str, ViewIR]
) -> tuple[list[SemanticRequirementIR], list[UntranslatableNote]]:
    requirements: list[SemanticRequirementIR] = []
    notes: list[UntranslatableNote] = []
    for index, row in enumerate(_required_records(model, "power_query")):
        name = row.get("Name") or row.get("TableName") or f"query_{index + 1}"
        expression = str(row.get("Expression") or "")
        if not expression.strip():
            raise ValueError(f"Power Query evidence for '{name}' is truncated: M expression is missing.")
        is_parameter = bool(row.get("IsParameter"))
        source_id = _source_id("power_query_parameter" if is_parameter else "power_query", name)
        if is_parameter:
            requirements.append(SemanticRequirementIR(
                source_id=source_id,
                source_locator=f"power_query[{name}]",
                object_type="parameter",
                name=str(name),
                support_outcome="decision_required",
                reason=(
                    "Power Query parameter values and environment bindings are not deployed "
                    "automatically. Map the parameter explicitly and review it for secrets."
                ),
                config={
                    "source_language": "Power Query M",
                    "parameter_type": str(row.get("Type") or "unknown"),
                    "allowed_value_count": len(row.get("AllowedValues") or []),
                    "review_only": True,
                },
            ))
            notes.append(UntranslatableNote(
                object=f"Power Query parameter {name}",
                severity="blocker",
                reason="Target parameter binding is required; source values were not copied automatically.",
            ))
            continue

        requirements.append(SemanticRequirementIR(
            source_id=source_id,
            source_locator=f"power_query[{name}]",
            object_type="derived_table",
            name=str(name),
            support_outcome="decision_required",
            reason=(
                "Power Query M controls source access and transformation placement. OmniKit "
                "preserved the expression but did not execute M or infer equivalent warehouse SQL."
            ),
            config={
                "source_language": "Power Query M",
                "expression": expression,
                "query_kind": str(row.get("Kind") or "unknown"),
                "review_only": True,
            },
        ))
        note = UntranslatableNote(
            object=f"Power Query {name}",
            severity="blocker",
            hint=expression,
            reason=(
                "Power Query M was preserved as review evidence only. Select a verified target "
                "relation or upstream transformation and compare source and target results."
            ),
        )
        view = views.get(_snake(str(name)))
        if view is not None:
            view.untranslatable.append(note)
        else:
            notes.append(note)
    return requirements, notes


def _security_requirements(
    model,
) -> tuple[list[SemanticRequirementIR], list[UntranslatableNote]]:
    requirements: list[SemanticRequirementIR] = []
    notes: list[UntranslatableNote] = []
    memberships_by_role: dict[str, int] = {}
    for membership in _optional_records(model, "tmschema_role_memberships"):
        role = str(membership.get("RoleName") or "")
        if not role:
            raise ValueError("Power BI role-membership evidence is truncated: role name is missing.")
        memberships_by_role[role] = memberships_by_role.get(role, 0) + 1

    roles_with_filters: set[str] = set()
    for row in _optional_records(model, "rls"):
        table = str(row.get("TableName") or "")
        role = str(row.get("RoleName") or "")
        expression = str(row.get("FilterExpression") or "")
        if not table or not role or not expression.strip():
            raise ValueError("Power BI RLS evidence is truncated: table, role, or filter is missing.")
        roles_with_filters.add(role)
        source_id = _source_id("rls", role, table)
        requirements.append(SemanticRequirementIR(
            source_id=source_id,
            source_locator=f"rls[{role}.{table}]",
            object_type="permission",
            name=f"{role}.{table}",
            support_outcome="decision_required",
            reason=(
                "Power BI model-role RLS is a DAX table filter. Recreate and validate the policy "
                "in Omni before assigning identities; identity members are intentionally redacted."
            ),
            config={
                "role_name": role,
                "table_name": table,
                "filter_expression": expression,
                "state": str(row.get("State") or "unknown"),
                "metadata_permission": str(row.get("MetadataPermission") or "unknown"),
                "membership_count": memberships_by_role.get(role, 0),
                "member_identities_included": False,
                "review_only": True,
            },
        ))
        notes.append(UntranslatableNote(
            object=f"RLS role {role} on {table}",
            severity="blocker",
            hint=expression,
            reason=(
                "RLS filter and membership semantics require explicit policy mapping and a "
                "controlled impersonation test; no identity assignment was emitted."
            ),
        ))

    for role, count in sorted(memberships_by_role.items()):
        if role in roles_with_filters:
            continue
        requirements.append(SemanticRequirementIR(
            source_id=_source_id("role_membership", role),
            source_locator=f"tmschema_role_memberships[RoleName={role}]",
            object_type="permission",
            name=role,
            support_outcome="manual",
            reason="Role memberships were detected without recoverable table-filter evidence.",
            config={
                "role_name": role,
                "membership_count": count,
                "member_identities_included": False,
                "review_only": True,
            },
        ))
        notes.append(UntranslatableNote(
            object=f"role membership {role}",
            severity="blocker",
            reason=(
                f"{count} role membership record(s) were detected, but identities were redacted "
                "and no RLS filter was recovered. Security review is required."
            ),
        ))
    return requirements, notes


def _calculation_group_requirements(
    model,
) -> tuple[list[SemanticRequirementIR], list[UntranslatableNote]]:
    requirements: list[SemanticRequirementIR] = []
    notes: list[UntranslatableNote] = []
    items_by_group: dict[str, list[dict[str, Any]]] = {}
    for row in _optional_records(model, "tmschema_calculation_items"):
        group_id = str(row.get("CalculationGroupID") or "")
        name = str(row.get("Name") or "")
        expression = str(row.get("Expression") or "")
        if not group_id or not name or not expression.strip():
            raise ValueError("Power BI calculation-item evidence is truncated.")
        items_by_group.setdefault(group_id, []).append({
            "source_id": _source_id("calculation_item", name, explicit=row.get("ID")),
            "name": name,
            "ordinal": row.get("Ordinal"),
            "expression": expression,
            "dependencies": _dax_lexical_evidence(expression)["dependencies"],
        })

    matched_groups: set[str] = set()
    for row in _optional_records(model, "tmschema_calculation_groups"):
        group_id = str(row.get("ID") or "")
        table = str(row.get("TableName") or "")
        if not group_id or not table:
            raise ValueError("Power BI calculation-group evidence is truncated.")
        matched_groups.add(group_id)
        items = sorted(items_by_group.get(group_id, []), key=lambda item: item.get("ordinal") or 0)
        dependencies = list(dict.fromkeys(
            dependency for item in items for dependency in item["dependencies"]
        ))
        requirements.append(SemanticRequirementIR(
            source_id=_source_id("calculation_group", table, explicit=row.get("ID")),
            source_locator=f"tmschema_calculation_groups[ID={group_id}]",
            object_type="extension",
            name=table,
            support_outcome="decision_required",
            reason=(
                "Calculation-group precedence, selection, format, and filter-context behavior "
                "have no deterministic Omni translation. Preserve or redesign each item explicitly."
            ),
            dependencies=dependencies,
            config={
                "precedence": row.get("Precedence"),
                "items": items,
                "review_only": True,
            },
        ))
        notes.append(UntranslatableNote(
            object=f"calculation group {table}",
            severity="blocker",
            reason=(
                f"Calculation group with {len(items)} item(s) requires reviewed target design and "
                "source-result validation; no DAX item was emitted as supported Omni code."
            ),
        ))

    orphan_group_ids = sorted(set(items_by_group) - matched_groups)
    if orphan_group_ids:
        raise ValueError(
            "Power BI calculation-item evidence references missing calculation groups: "
            + ", ".join(orphan_group_ids)
        )
    return requirements, notes


def _hierarchy_requirements(
    model,
) -> tuple[list[SemanticRequirementIR], list[UntranslatableNote]]:
    requirements: list[SemanticRequirementIR] = []
    notes: list[UntranslatableNote] = []
    levels_by_hierarchy: dict[str, list[dict[str, Any]]] = {}
    for row in _optional_records(model, "tmschema_levels"):
        hierarchy_id = str(row.get("HierarchyID") or "")
        name = str(row.get("Name") or "")
        column = str(row.get("ColumnName") or "")
        if not hierarchy_id or not name or not column:
            raise ValueError("Power BI hierarchy-level evidence is truncated.")
        levels_by_hierarchy.setdefault(hierarchy_id, []).append({
            "source_id": _source_id("hierarchy_level", name, explicit=row.get("ID")),
            "name": name,
            "column": column,
            "ordinal": row.get("Ordinal"),
        })

    matched_hierarchies: set[str] = set()
    for row in _optional_records(model, "tmschema_hierarchies"):
        hierarchy_id = str(row.get("ID") or "")
        table = str(row.get("TableName") or "")
        name = str(row.get("Name") or "")
        if not hierarchy_id or not table or not name:
            raise ValueError("Power BI hierarchy evidence is truncated.")
        matched_hierarchies.add(hierarchy_id)
        levels = sorted(
            levels_by_hierarchy.get(hierarchy_id, []),
            key=lambda item: item.get("ordinal") or 0,
        )
        requirements.append(SemanticRequirementIR(
            source_id=_source_id("hierarchy", table, name, explicit=row.get("ID")),
            source_locator=f"tmschema_hierarchies[ID={hierarchy_id}]",
            object_type="extension",
            name=f"{table}.{name}",
            support_outcome="decision_required",
            reason="Hierarchy order and drill behavior require explicit target review.",
            dependencies=[f"{table}.{level['column']}" for level in levels],
            config={
                "table_name": table,
                "levels": levels,
                "hidden": bool(row.get("IsHidden")),
                "display_folder": row.get("DisplayFolder"),
                "review_only": True,
            },
        ))
        notes.append(UntranslatableNote(
            object=f"hierarchy {table}.{name}",
            severity="blocker",
            reason=(
                f"Hierarchy with {len(levels)} ordered level(s) was preserved for review but not "
                "emitted as an equivalent Omni interaction."
            ),
        ))

    orphan_hierarchy_ids = sorted(set(levels_by_hierarchy) - matched_hierarchies)
    if orphan_hierarchy_ids:
        raise ValueError(
            "Power BI hierarchy levels reference missing hierarchies: "
            + ", ".join(orphan_hierarchy_ids)
        )
    return requirements, notes


def _partition_requirements(
    model, views: dict[str, ViewIR], power_query_names: set[str]
) -> tuple[list[SemanticRequirementIR], list[UntranslatableNote]]:
    requirements: list[SemanticRequirementIR] = []
    notes: list[UntranslatableNote] = []
    partitions_by_table: dict[str, list[dict[str, Any]]] = {}
    for row in _optional_records(model, "tmschema_partitions"):
        table = str(row.get("TableName") or "")
        name = str(row.get("Name") or "")
        if not table or not name:
            raise ValueError("Power BI partition evidence is truncated: table or partition name is missing.")
        partitions_by_table.setdefault(table, []).append({
            "source_id": _source_id("partition", table, name, explicit=row.get("ID")),
            "name": name,
            "type": row.get("Type"),
            "mode": row.get("Mode"),
            "data_view": row.get("DataView"),
            "data_source_id_present": row.get("DataSourceID") is not None,
            "query_definition": row.get("QueryDefinition"),
        })

    for view in views.values():
        table = view.source_table or view.name
        partitions = partitions_by_table.get(table, [])
        if not partitions and table not in power_query_names:
            notes.append(UntranslatableNote(
                object=f"table placement {table}",
                severity="blocker",
                reason=(
                    "Neither Power Query nor partition evidence identified this table's physical "
                    "source. The generated source_table is a review-only placeholder."
                ),
            ))
            continue
        if not partitions:
            continue
        modes = sorted({str(item.get("mode") or "unknown") for item in partitions})
        requirements.append(SemanticRequirementIR(
            source_id=_source_id("table_placement", table),
            source_locator=f"tmschema_partitions[TableName={table}]",
            object_type="query_validation",
            name=f"{table} source placement",
            support_outcome="decision_required",
            reason=(
                "Partition/storage-mode behavior must be mapped to a verified Omni connection, "
                "warehouse relation, or upstream transformation before model deployment."
            ),
            config={"partitions": partitions, "storage_modes": modes, "review_only": True},
        ))
        notes.append(UntranslatableNote(
            object=f"table placement {table}",
            severity="blocker",
            reason=(
                f"Recovered {len(partitions)} partition(s) with storage mode(s) {modes}; target "
                "placement and source-result parity must be confirmed."
            ),
        ))
    return requirements, notes


def _build_topics(
    views: dict[str, ViewIR], model
) -> tuple[list[TopicIR], list[SemanticRequirementIR], list[UntranslatableNote]]:
    topics: dict[str, TopicIR] = {}
    requirements: list[SemanticRequirementIR] = []
    notes: list[UntranslatableNote] = []
    for row in _required_records(model, "relationships"):
        from_table, from_col = row.get("FromTableName"), row.get("FromColumnName")
        to_table, to_col = row.get("ToTableName"), row.get("ToColumnName")
        object_name = f"relationship {from_table or '?'}->{to_table or '?'}"
        source_id = _source_id("relationship", from_table, from_col, to_table, to_col)
        if not all((from_table, from_col, to_table, to_col)):
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason="Relationship endpoint evidence is incomplete; no join was emitted.",
            ))
            continue
        from_view, to_view = _snake(from_table), _snake(to_table)
        if from_view not in views or to_view not in views:
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason="Relationship references a table that was not recovered; no join was emitted.",
            ))
            continue
        if row.get("IsActive") is None:
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason="Relationship active-state evidence is missing; no join was emitted.",
            ))
            continue
        if not bool(row.get("IsActive")):
            requirements.append(SemanticRequirementIR(
                source_id=source_id,
                source_locator=f"relationships[{from_table}.{from_col}->{to_table}.{to_col}]",
                object_type="extension",
                name=object_name,
                support_outcome="decision_required",
                reason=(
                    "Inactive Power BI relationships affect measures through USERELATIONSHIP. "
                    "Usage cannot be proven from lexical DAX evidence, so no active Omni join was emitted."
                ),
                config={"active": False, "review_only": True},
            ))
            views[from_view].untranslatable.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason="Inactive relationship may be activated by DAX; explicit dependency review is required.",
            ))
            continue
        cardinality = str(row.get("Cardinality") or "")
        if cardinality not in {"M:1", "1:M", "1:1", "M:M"}:
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason=f"Relationship cardinality '{cardinality or 'missing'}' is not verified; no join was emitted.",
            ))
            continue
        cross_filter = str(row.get("CrossFilteringBehavior") or "")
        if cross_filter and cross_filter not in {"Single", "Both"}:
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason=f"Cross-filter behavior '{cross_filter or 'missing'}' is not verified; no join was emitted.",
            ))
            continue
        from_card, to_card = cardinality.split(":")
        if from_card == "M" and to_card == "M":
            relationship_type = "many_to_many"
        elif from_card == "M":
            relationship_type = "many_to_one"
        elif to_card == "M":
            relationship_type = "one_to_many"
        else:
            relationship_type = "one_to_one"

        if cross_filter == "Both" or relationship_type == "many_to_many":
            requirements.append(SemanticRequirementIR(
                source_id=source_id,
                source_locator=f"relationships[{from_table}.{from_col}->{to_table}.{to_col}]",
                object_type="extension",
                name=object_name,
                support_outcome="decision_required",
                reason=(
                    "Power BI bidirectional or many-to-many filter propagation is not represented "
                    "by a plain Omni join and requires an explicit target design."
                ),
                config={
                    "cardinality": cardinality,
                    "cross_filtering_behavior": cross_filter,
                    "review_only": True,
                },
            ))
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason=(
                    f"{cross_filter} cross-filter with {cardinality} cardinality requires reviewed "
                    "filter-propagation design; no join was emitted."
                ),
            ))
            continue

        if not cross_filter:
            requirements.append(SemanticRequirementIR(
                source_id=source_id,
                source_locator=f"relationships[{from_table}.{from_col}->{to_table}.{to_col}]",
                object_type="query_validation",
                name=f"{object_name} filter direction",
                support_outcome="decision_required",
                reason=(
                    "The source parser did not expose Power BI cross-filter direction. The key "
                    "relationship can be inventoried, but filter propagation requires review."
                ),
                config={"cardinality": cardinality, "review_only": True},
            ))
            notes.append(UntranslatableNote(
                object=object_name,
                severity="blocker",
                reason=(
                    "Cross-filter direction was not exposed. The join was retained for review, "
                    "but deployment remains blocked until filter propagation is confirmed."
                ),
            ))

        topic = topics.setdefault(
            from_view,
            TopicIR(
                source_id=_source_id("topic", from_table),
                source_locator=f"relationships[FromTableName={from_table}]",
                name=from_view,
                base_view=from_view,
            ),
        )
        topic.joins.append(
            JoinIR(
                source_id=source_id,
                source_locator=f"relationships[{from_table}.{from_col}->{to_table}.{to_col}]",
                join_from_view=from_view, join_to_view=to_view,
                relationship_type=relationship_type,
                on_sql=f"${{{from_view}.{_snake(from_col)}}} = ${{{to_view}.{_snake(to_col)}}}",
            )
        )
        if bool(row.get("RelyOnReferentialIntegrity")):
            views[from_view].untranslatable.append(UntranslatableNote(
                object=object_name,
                severity="warning",
                reason=(
                    "Power BI relies on referential integrity for this relationship. OmniKit "
                    "emitted a left join; validate null and unmatched-key behavior."
                ),
            ))
    return list(topics.values()), requirements, notes


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
            if path.stat().st_size > _MAX_POWER_BI_ARTIFACT_BYTES:
                raise ValueError(
                    f"Power BI artifact exceeds the {_MAX_POWER_BI_ARTIFACT_BYTES} byte parser limit: "
                    f"{path.name}"
                )
            with zipfile.ZipFile(path) as archive:
                validate_zip_archive(archive, path.name)
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
            except KeyError:  # Report/Layout is optional; policy and parse failures must surface.
                layout = None
            if layout is not None:
                attach_visual_aggregate_hints(layout, {v.name: v for v in bundle.views})
                from omni_migrator.extractors.powerbi.dashboard import translate_powerbi_layout

                dashboards.extend(translate_powerbi_layout(layout, source_url=path.name))
            model.views.extend(bundle.views)
            model.topics.extend(bundle.topics)
            model.requirements.extend(bundle.requirements)
            model.untranslatable.extend(bundle.untranslatable)
            if layout is None:
                model.untranslatable.append(UntranslatableNote(
                    object=f"report definition {path.name}",
                    severity="blocker",
                    reason=(
                        "The PBIX did not expose the legacy Report/Layout member. No dashboard "
                        "definition was emitted; PBIR/PBIR-Legacy project parsing is not supported "
                        "by this extractor."
                    ),
                ))
        return MigrationBundle(
            source="powerbi",
            provenance=Provenance(source_artifact=", ".join(artifacts)),
            model=model,
            dashboards=dashboards,
        )


class _PartialModel:
    """Plain container so `_build_bundle`'s result composes into `ModelIR` above."""

    def __init__(self, views, topics, requirements, untranslatable):
        self.views = views
        self.topics = topics
        self.requirements = requirements
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
    calc_table_rows = _required_records(model, "dax_tables")
    calc_tables = {r["TableName"] for r in calc_table_rows if r.get("TableName")}
    views, _calc_columns = _build_views(model, dialect, calc_tables)
    requirements: list[SemanticRequirementIR] = []
    notes = _calculated_table_notes(model)
    missing_optional_frames = _missing_optional_frames(model)
    if missing_optional_frames:
        notes.append(UntranslatableNote(
            object="Power BI extended semantic metadata",
            severity="blocker",
            reason=(
                "The parser did not expose optional evidence frames: "
                + ", ".join(missing_optional_frames)
                + ". Core model inventory can continue, but security, calculation-group, hierarchy, "
                "partition, and native object-ID coverage must be reviewed before deployment."
            ),
        ))
    notes.extend(_add_calculated_columns(views, model, requirements))
    notes.extend(_add_measures(views, model, requirements))

    for row in calc_table_rows:
        table = row.get("TableName")
        expression = str(row.get("Expression") or "")
        requirements.append(SemanticRequirementIR(
            source_id=_source_id("calculated_table", table),
            source_locator=f"dax_tables[{table}]",
            object_type="derived_table",
            name=str(table),
            support_outcome="decision_required",
            reason=(
                "DAX calculated-table semantics require a reviewed upstream or Omni query-view "
                "design; no source SQL was inferred."
            ),
            dependencies=_dax_lexical_evidence(expression, str(table))["dependencies"],
            config={"source_language": "DAX", "expression": expression, "review_only": True},
        ))

    power_query_requirements, power_query_notes = _power_query_requirements(model, views)
    requirements.extend(power_query_requirements)
    notes.extend(power_query_notes)
    power_query_names = {
        str(row.get("Name") or row.get("TableName"))
        for row in _required_records(model, "power_query")
        if row.get("Name") or row.get("TableName")
    }

    partition_requirements, partition_notes = _partition_requirements(
        model, views, power_query_names
    )
    requirements.extend(partition_requirements)
    notes.extend(partition_notes)

    security_requirements, security_notes = _security_requirements(model)
    requirements.extend(security_requirements)
    notes.extend(security_notes)

    calculation_group_requirements, calculation_group_notes = _calculation_group_requirements(model)
    requirements.extend(calculation_group_requirements)
    notes.extend(calculation_group_notes)

    hierarchy_requirements, hierarchy_notes = _hierarchy_requirements(model)
    requirements.extend(hierarchy_requirements)
    notes.extend(hierarchy_notes)

    topics, relationship_requirements, relationship_notes = _build_topics(views, model)
    requirements.extend(relationship_requirements)
    notes.extend(relationship_notes)
    return _PartialModel(list(views.values()), topics, requirements, notes)

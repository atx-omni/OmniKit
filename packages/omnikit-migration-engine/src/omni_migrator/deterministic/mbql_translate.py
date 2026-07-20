"""Deterministic MBQL -> Omni mapping (stage 1/3 of the sandwich, Metabase's analog of
`dax_translate.py`/the Tableau calc classifier).

MBQL (Metabase Query Language) is a structured JSON AST, not a string formula language like DAX or
Tableau's calc syntax — that makes filters and breakouts more tractable here than in either of those
extractors. Aggregations and custom expressions stay just as narrowly scoped as DAX's: translate only
the genuinely unambiguous shape, flag everything else `untranslatable` with the raw MBQL clause as the
AI hint, never guess (plan §12.2 discipline).

Three distinct translation targets, each with different constraints:

1. `translate_filter_clause` -> raw boolean SQL (for a Metabase *segment*'s `sql:` on a yesno
   dimension). No fixed wire-format to match, so this covers the full filter-clause surface.
2. `translate_measure_filter` -> Omni's measure `filters:` YAML dict (`{field: {is: value}}`,
   verified against plan Appendix A.11's worked example — the *only* confirmed wire shape). Narrowed
   to equals/not-equals (optionally AND'd across distinct fields) because that's all that's verified;
   do not extend this to other operators without confirming the wire key against a real instance.
3. `translate_aggregation` -> a measure `FieldIR`'s `(sql, aggregate)`, using (2) for
   `count-where`/`sum-where`.

All functions take a plain `field_index: dict[int, FieldMeta]` (Metabase field id -> table/column) —
no Metabase-client dependency, so this is unit-testable without any API/server involved.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FieldMeta:
    view: str  # snake view name (== source table's snake name)
    name: str  # snake field name (== source column's snake name)
    table_id: int


FieldIndex = dict[int, FieldMeta]


def _strip_pmbql_opts(node: object) -> object:
    """Recursively restore the legacy MBQL clause shape (`[op, operand, ...]`) from Metabase's
    newer "pMBQL" wire format, which inserts a `{"lib/uuid": ..., ...}` options dict as every
    clause's *second* element (`["field", id, opts]` -> `["field", {opts}, id]`; `["metric", id]`
    -> `["metric", {opts}, id]`; `["=", ref, val]` -> `["=", {opts}, ref, val]`; etc.) — verified
    live against a real v0.62 instance, not documented anywhere we could find and not gated behind
    any version check we could pin against, so this detects the shape structurally (a dict
    containing `lib/uuid` in clause-operand position) rather than trusting a version number.

    Every parser below was written against the legacy shape; rather than touch each one's
    positional indexing, this normalizes the whole clause tree once at the entry point. The opts
    dict itself carries nothing any parser reads except a `field` ref's `source-field` (join
    detection, `resolve_field_ref`) — preserved by re-appending it at the legacy 3rd-position
    slot only for `field` clauses; dropped everywhere else since it's pure noise there.

    A list is only treated as *one clause* to strip (rather than a list of sibling clauses, e.g.
    `breakout`/`aggregation`/`filters`) when its first element is a string operator (`"field"`,
    `"metric"`, `"="`, ...) — a list of clauses has a list as its first element instead, so it
    falls through to plain elementwise recursion. Every element is recursed into *before* that
    check either way, so nested clauses normalize regardless of which case applies above them.
    """
    if isinstance(node, list):
        items = [_strip_pmbql_opts(x) for x in node]
        if (
            len(items) > 1 and isinstance(items[0], str)
            and isinstance(items[1], dict) and "lib/uuid" in items[1]
        ):
            op, opts, rest = items[0], items[1], items[2:]
            if op == "field":
                rest = [*rest, opts]
            return [op, *rest]
        return items
    if isinstance(node, dict):
        return {k: _strip_pmbql_opts(v) for k, v in node.items()}
    return node


def normalize_query_stage(dataset_query: dict) -> tuple[bool, dict]:
    """A card/metric's `dataset_query` -> `(is_native, query)`, tolerant of both the legacy
    `{type: 'native'|'query', native|query: {...}}` wire shape and the newer pMBQL
    `{stages: [{'lib/type': 'mbql.stage/native'|'mbql.stage/mbql', ...}]}` shape (verified live,
    §6.5's caveat — Metabase moved to this without a version bump we could pin against).

    - Native: `query` is always `{"query": <sql str>, "template-tags": {...}}` regardless of
      which wire shape it came from.
    - MBQL: `query` has the legacy top-level keys (`source-table`, `aggregation`, `breakout`,
      `filter` — singular, `and`-composed from pMBQL's plural `filters` list when there's more
      than one — `order-by`, `limit`), every clause tree stripped of pMBQL's injected opts dicts
      via `_strip_pmbql_opts`, so every parser in this module needs no shape-awareness at all.
    """
    if "stages" in dataset_query:
        stage = (dataset_query.get("stages") or [{}])[-1]
        if stage.get("lib/type") == "mbql.stage/native":
            native = stage.get("native")
            if isinstance(native, str):
                return True, {"query": native, "template-tags": {}}
            native = native or {}
            return True, {"query": native.get("query"), "template-tags": native.get("template-tags", {})}
        norm = _strip_pmbql_opts(stage)
        filters = norm.get("filters")
        if filters:
            norm["filter"] = filters[0] if len(filters) == 1 else ["and", *filters]
        return False, norm
    if dataset_query.get("type") == "native":
        native = dataset_query.get("native") or {}
        return True, {"query": native.get("query"), "template-tags": native.get("template-tags", {})}
    return False, dataset_query.get("query") or {}


_AGG_SIMPLE = {
    "sum": "sum", "avg": "average", "min": "min", "max": "max",
    "median": "median", "distinct": "count_distinct",
}
# No deterministic Omni equivalent (time-intelligence/stat-function family) — mirrors DAX's
# CALCULATE/time-intelligence treatment in `dax_translate.py`.
_AGG_UNSUPPORTED = {"cum-sum", "cum-count", "stddev", "var", "share"}

_CMP_SQL = {"=": "=", "!=": "<>", ">": ">", ">=": ">=", "<": "<", "<=": "<="}
_ARITH = {"+": "+", "-": "-", "*": "*", "/": "/"}


def resolve_field_ref(
    ref: object, field_index: FieldIndex, home_table_id: int
) -> tuple[str | None, str | None]:
    """MBQL `["field", id, opts]` -> `(bare_column_sql, reason)`. Exactly one is set.

    Only a concrete, own-table field id resolves deterministically. A `source-field` option
    (field reached through a join) or a non-integer id (nested-query alias) always needs AI —
    same posture as DAX/PowerBI's cross-table measure refs.
    """
    if not (isinstance(ref, list) and len(ref) >= 2 and ref[0] == "field"):
        return None, f"Not a field reference: {ref!r}"
    field_id = ref[1]
    opts = ref[2] if len(ref) > 2 and isinstance(ref[2], dict) else {}
    if not isinstance(field_id, int):
        return None, f"Non-concrete field reference (nested-query alias {field_id!r}); needs AI translation."
    if opts.get("source-field"):
        return None, "Field reached through a join (source-field); needs AI translation."
    meta = field_index.get(field_id)
    if meta is None:
        return None, f"Unknown field id {field_id}."
    if meta.table_id != home_table_id:
        return None, f"References another table (field {field_id} on table {meta.table_id}); needs AI translation."
    return meta.name, None


def _sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def translate_filter_clause(
    clause: object, field_index: FieldIndex, home_table_id: int
) -> tuple[str | None, str | None]:
    """MBQL filter clause -> raw boolean SQL expression (for a segment's `sql:`).

    Full operator coverage (unlike `translate_measure_filter`) since there's no fixed wire-format
    to match here — this just needs to be valid SQL. `or` and relative-date (`time-interval`)
    clauses have no deterministic boolean-SQL form in v1 and always need AI.
    """
    if not (isinstance(clause, list) and clause):
        return None, f"Invalid filter clause: {clause!r}"
    op = clause[0]

    if op == "and":
        parts: list[str] = []
        for sub in clause[1:]:
            sql, reason = translate_filter_clause(sub, field_index, home_table_id)
            if reason:
                return None, reason
            parts.append(sql)
        return "(" + " AND ".join(parts) + ")", None
    if op == "or":
        return None, f"OR filter clauses have no deterministic Omni equivalent: {clause!r}; needs AI translation."
    if op == "not":
        if len(clause) != 2:
            return None, f"Malformed NOT clause: {clause!r}"
        inner, reason = translate_filter_clause(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return f"NOT ({inner})", None
    if op in _CMP_SQL and len(clause) == 3:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return f"{col} {_CMP_SQL[op]} {_sql_literal(clause[2])}", None
    if op == "between" and len(clause) == 4:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return f"{col} BETWEEN {_sql_literal(clause[2])} AND {_sql_literal(clause[3])}", None
    if op in ("starts-with", "ends-with", "contains") and len(clause) >= 3:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        pattern = {
            "starts-with": f"{clause[2]}%", "ends-with": f"%{clause[2]}", "contains": f"%{clause[2]}%",
        }[op]
        return f"{col} LIKE {_sql_literal(pattern)}", None
    if op == "is-null" and len(clause) == 2:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        return (None, reason) if reason else (f"{col} IS NULL", None)
    if op == "not-null" and len(clause) == 2:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        return (None, reason) if reason else (f"{col} IS NOT NULL", None)
    if op == "time-interval":
        return None, f"Relative-date filter has no deterministic boolean-SQL form in v1: {clause!r}; needs AI translation."
    return None, f"Unsupported/unrecognized filter clause: {clause!r}"


def translate_measure_filter(
    clause: object, field_index: FieldIndex, home_table_id: int
) -> tuple[dict[str, dict] | None, str | None]:
    """MBQL filter clause -> Omni's measure `filters:` dict (`{field: {is|is_not: value}}`).

    Narrowed to `=`/`!=` (optionally AND'd across *distinct* fields) — the only wire shape
    confirmed by a real Omni YAML sample (plan Appendix A.11's worked example uses `is:`).
    Anything else (ranges, OR, repeated conditions on one field) always needs AI translation
    rather than guessing an unverified filter-kind key.
    """
    clauses = clause[1:] if isinstance(clause, list) and clause and clause[0] == "and" else [clause]
    out: dict[str, dict] = {}
    for c in clauses:
        if not (isinstance(c, list) and len(c) == 3 and c[0] in ("=", "!=")):
            return None, f"Filter clause is not a simple equals/not-equals (or AND of them): {clause!r}"
        field_name, reason = resolve_field_ref(c[1], field_index, home_table_id)
        if reason:
            return None, reason
        if field_name in out:
            return None, f"Multiple conditions on the same field {field_name!r}; needs AI translation."
        out[field_name] = {"is": c[2]} if c[0] == "=" else {"is_not": c[2]}
    return out, None


_QUERY_CMP = {
    "=": "equals", "!=": "equals", ">": "greater_than", ">=": "greater_than",
    "<": "less_than", "<=": "less_than",
}


def translate_filter_to_conditions(
    clause: object, field_index: FieldIndex, home_table_id: int
) -> tuple[list[tuple[str, str, list[str], bool]] | None, str | None]:
    """MBQL filter clause -> a list of `(field, operator, values, is_negative)` tuples (the
    canonical `FilterIR` shape, plan Appendix A.10) — for dashboard/query-level filters. Unlike
    `translate_measure_filter`'s dict (locked to a verified Omni wire shape), `FilterIR` has no
    fixed wire-format to match here, so the fuller operator table applies (returns plain tuples,
    not `FilterIR` objects, to keep this module free of an `ir.schema` dependency — the caller
    constructs the IR type, same convention as `dax_translate.py`).
    """
    if not (isinstance(clause, list) and clause):
        return None, f"Invalid filter clause: {clause!r}"
    op = clause[0]

    if op == "and":
        out: list[tuple[str, str, list[str], bool]] = []
        for sub in clause[1:]:
            conds, reason = translate_filter_to_conditions(sub, field_index, home_table_id)
            if reason:
                return None, reason
            out.extend(conds)
        return out, None
    if op == "or":
        return None, f"OR filter clauses have no FilterIR representation: {clause!r}; needs AI translation."
    if op == "not":
        if len(clause) != 2:
            return None, f"Malformed NOT clause: {clause!r}"
        conds, reason = translate_filter_to_conditions(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return [(f, o, v, not neg) for f, o, v, neg in conds], None
    if op in _QUERY_CMP and len(clause) == 3:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return [(col, _QUERY_CMP[op], [str(clause[2])], op == "!=")], None
    if op == "between" and len(clause) == 4:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return [(col, "between", [str(clause[2]), str(clause[3])], False)], None
    if op in ("starts-with", "ends-with", "contains") and len(clause) >= 3:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        kind = {"starts-with": "starts_with", "ends-with": "ends_with", "contains": "contains"}[op]
        return [(col, kind, [str(clause[2])], False)], None
    if op in ("is-null", "not-null") and len(clause) == 2:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, reason
        return [(col, "is_empty", [], op == "not-null")], None
    if op == "time-interval":
        return None, f"Relative-date filter has no deterministic FilterIR form in v1: {clause!r}; needs AI translation."
    return None, f"Unsupported/unrecognized filter clause: {clause!r}"


def translate_aggregation(
    clause: object, field_index: FieldIndex, home_table_id: int
) -> tuple[str | None, str | None, dict[str, dict] | None, str | None]:
    """MBQL `:aggregation` clause (or a metric/legacy-`/api/metric` definition) -> `(sql, aggregate,
    filters, reason)`. Exactly one of `(sql?, aggregate, filters?)` or `reason` is meaningfully set;
    `sql` is `None` for row-counting aggregates, matching Omni's count-of-rows convention.
    """
    if not (isinstance(clause, list) and clause):
        return None, None, None, f"Empty/invalid aggregation clause: {clause!r}"
    op = clause[0]

    if op == "aggregation-options":
        inner = clause[1] if len(clause) > 1 else None
        if inner is None:
            return None, None, None, "Empty `aggregation-options` wrapper."
        return translate_aggregation(inner, field_index, home_table_id)
    if op == "count" and len(clause) == 1:
        return None, "count", None, None
    if op in _AGG_SIMPLE and len(clause) == 2:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, None, None, reason
        return col, _AGG_SIMPLE[op], None, None
    if op == "count-where" and len(clause) == 2:
        filters, reason = translate_measure_filter(clause[1], field_index, home_table_id)
        if reason:
            return None, None, None, reason
        return None, "count", filters, None
    if op == "sum-where" and len(clause) == 3:
        col, reason = resolve_field_ref(clause[1], field_index, home_table_id)
        if reason:
            return None, None, None, reason
        filters, reason = translate_measure_filter(clause[2], field_index, home_table_id)
        if reason:
            return None, None, None, reason
        return col, "sum", filters, None
    if op in _AGG_UNSUPPORTED:
        return None, None, None, f"Metabase aggregation '{op}' has no deterministic Omni equivalent: {clause!r}; needs AI translation."
    return None, None, None, f"Unsupported/unrecognized aggregation clause: {clause!r}"


def translate_expression(
    expr: object, field_index: FieldIndex, home_table_id: int
) -> tuple[str | None, str | None]:
    """MBQL `:expression` (custom calculated column) -> `(sql, reason)`.

    Deterministic only for pure arithmetic over literals and own-table field refs — `case`,
    `coalesce`, string/date functions, and refs to another `:expression` always need AI, same
    narrowness as DAX calculated columns in `dax_translate.py` (which are *always* untranslatable —
    MBQL's structured arithmetic is the one place this format gives a real, if modest, edge).
    """
    if isinstance(expr, bool):
        return None, f"Unsupported expression literal: {expr!r}"
    if isinstance(expr, (int, float)):
        return str(expr), None
    if isinstance(expr, list) and expr and expr[0] == "field":
        col, reason = resolve_field_ref(expr, field_index, home_table_id)
        return (None, reason) if reason else (col, None)
    if isinstance(expr, list) and len(expr) >= 3 and expr[0] in _ARITH:
        parts: list[str] = []
        for operand in expr[1:]:
            sql, reason = translate_expression(operand, field_index, home_table_id)
            if reason:
                return None, reason
            parts.append(f"({sql})")
        return f" {_ARITH[expr[0]]} ".join(parts), None
    return None, f"Unsupported expression clause: {expr!r}; needs AI translation."

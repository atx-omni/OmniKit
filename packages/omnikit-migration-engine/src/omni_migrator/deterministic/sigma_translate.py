"""Deterministic Sigma formula -> Omni measure/dimension mapping (Appendix A.7-style, §6.4).

Same scoping discipline as `dax_translate.py`/`mbql_translate.py`: translate only the clean,
unambiguous shapes; everything else (Lookup, Window* functions, OR conditions, multi-table
expressions) is flagged `untranslatable` with the raw formula as the AI hint, never guessed.

Sigma formulas use bracket-notation column refs — `[Column Name]` for the same table,
`[Table Name/Column Name]` cross-table (plan §6.4) — and a `*If(value, condition)` family
(`SumIf`/`CountIf`/`AvgIf`) that's structurally a filtered aggregate, the same Omni measure
`filters:` wire shape `mbql_translate.translate_measure_filter` already produces (`{field: {is:
value}}` — the one shape verified against real Omni YAML, Appendix A.11).

**Not verified against a live Sigma instance** — built from `help.sigmacomputing.com`'s public
docs (function index + worked `SumIf`/`Lookup` examples) only, since no live access exists yet
(plan §6.4). Treat with the same skepticism as Tableau's dashboard translator until spot-checked
live — in particular, `CountIf`'s exact arity (1-arg condition-only vs. 2-arg value+condition,
mirroring MBQL's `count-where` vs. `sum-where` split) is inferred, not confirmed from a worked
doc example the way `SumIf` is.
"""

from __future__ import annotations

import re


def _snake(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", (text or "").strip()).strip("_").lower()
    if s and s[0].isdigit():
        s = f"f_{s}"
    return s or "field"


# `[Column Name]` (same table) or `[Table Name/Column Name]` (cross-table) — a *whole* bracket
# ref, not embedded in a larger expression (callers check this spans the full argument text).
_BRACKET_REF = re.compile(r"\[\s*(?:([^\[\]/]+?)\s*/\s*)?\s*([^\[\]/]+?)\s*\]")

_AGG_MAP = {
    "sum": "sum", "average": "average", "avg": "average", "count": "count",
    "countdistinct": "count_distinct", "min": "min", "max": "max", "median": "median",
}
# FUNC ( <single-ref-arg-or-empty> ) — the only deterministically-safe plain-aggregate shape.
_SIMPLE_AGG = re.compile(
    r"^\s*(Sum|Average|Avg|Count|CountDistinct|Min|Max|Median)\s*\(\s*(.*?)\s*\)\s*$",
    re.IGNORECASE | re.DOTALL,
)
# The `*If(value, condition)` family — structurally a filtered aggregate (plan §6.4).
_IF_AGG = re.compile(r"^\s*(Sum|Count|Avg|Average)If\s*\(\s*(.*)\s*\)\s*$", re.IGNORECASE | re.DOTALL)
# Functions with no deterministic Omni equivalent at all (cross-row/cross-table lookups, window
# functions) — never attempt a translation, just flag.
_NO_EQUIVALENT = re.compile(r"^\s*(Lookup|Window\w*)\s*\(", re.IGNORECASE)

_COND_CMP = re.compile(r"^(.+?)\s*(!=|<>|=)\s*(.+)$")


def parse_ref(text: str) -> tuple[str | None, str] | None:
    """A bracket ref spanning the *whole* string -> `(table_or_None, column)`, else `None`."""
    m = _BRACKET_REF.fullmatch(text.strip())
    if not m:
        return None
    table, column = m.group(1), m.group(2)
    return (table.strip() if table else None), column.strip()


def _split_top_level_args(text: str) -> list[str]:
    """Split a function call's argument text on top-level commas — respecting quoted string
    literals and nested parens/brackets, since a condition arg can itself contain commas inside
    a quoted value (e.g. `[City] = "Springfield, IL"`)."""
    args: list[str] = []
    buf: list[str] = []
    depth = 0
    in_str = False
    for ch in text:
        if in_str:
            buf.append(ch)
            if ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            buf.append(ch)
        elif ch in "([":
            depth += 1
            buf.append(ch)
        elif ch in ")]":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            args.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    args.append("".join(buf))
    return [a.strip() for a in args]


def _literal(text: str) -> object:
    text = text.strip()
    if text.startswith('"') and text.endswith('"') and len(text) >= 2:
        return text[1:-1]
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def translate_condition(expr: str, home_table: str | None = None) -> tuple[dict[str, dict] | None, str | None]:
    """A Sigma formula boolean condition -> Omni measure `filters:` dict (the one wire shape
    verified against real Omni YAML, `{field: {is|is_not: value}}` — mirrors
    `mbql_translate.translate_measure_filter`). Narrowed to `=`/`!=` (optionally ANDed across
    distinct fields), same as that function — OR has no deterministic Omni equivalent."""
    expr = expr.strip()
    if re.search(r"\bor\b", expr, re.IGNORECASE):
        return None, f"OR conditions have no deterministic Omni measure-filter equivalent: {expr!r}; needs AI translation."
    parts = re.split(r"\s+and\s+", expr, flags=re.IGNORECASE)
    out: dict[str, dict] = {}
    for part in parts:
        m = _COND_CMP.match(part.strip())
        if not m:
            return None, f"Condition is not a simple equals/not-equals: {part!r}; needs AI translation."
        lhs, op, rhs = m.groups()
        ref = parse_ref(lhs)
        if ref is None:
            return None, f"Left-hand side is not a single column reference: {lhs!r}; needs AI translation."
        table, column = ref
        table = _snake(table) if table else None
        column = _snake(column)
        if table and home_table and table != home_table:
            return None, f"Cross-table condition ({lhs}); needs AI translation."
        if column in out:
            return None, f"Multiple conditions on the same field {column!r}; needs AI translation."
        out[column] = {"is": _literal(rhs)} if op == "=" else {"is_not": _literal(rhs)}
    return out, None


def translate_formula(
    formula: str, home_table: str | None = None
) -> tuple[str | None, str | None, dict[str, dict] | None, str | None]:
    """Try to deterministically translate a Sigma measure formula.

    Returns `(sql, aggregate, filters, reason)` — exactly one of `(sql?, aggregate, filters?)`
    or `reason` is meaningfully set. `sql` is `None` for row-counting aggregates (bare `Count()`
    or a condition-only `CountIf(...)`), matching Omni's count-of-rows convention.
    """
    expr = (formula or "").strip()
    if not expr:
        return None, None, None, "Empty formula."
    if _NO_EQUIVALENT.match(expr):
        return None, None, None, f"No deterministic Omni equivalent for this function: {expr!r}; needs AI translation."

    m = _IF_AGG.match(expr)
    if m:
        func = m.group(1).lower()
        args = _split_top_level_args(m.group(2))
        aggregate = _AGG_MAP.get(func, func)
        if func == "count":
            # CountIf's exact arity isn't confirmed live (see module docstring) — accept either
            # a condition-only arg (mirrors MBQL's count-where) or an explicit (value, condition)
            # pair (mirrors sum-where), rather than assuming one and rejecting the other.
            if len(args) == 1:
                condition = args[0]
            elif len(args) == 2:
                condition = args[1]
            else:
                return None, None, None, f"Unexpected CountIf argument count: {expr!r}; needs AI translation."
            filters, reason = translate_condition(condition, home_table)
            if reason:
                return None, None, None, reason
            return None, "count", filters, None
        if len(args) != 2:
            return None, None, None, f"Unexpected {m.group(1)}If argument count: {expr!r}; needs AI translation."
        value_arg, condition = args
        ref = parse_ref(value_arg)
        if ref is None:
            return None, None, None, f"{m.group(1)}If's value argument is not a single column reference: {value_arg!r}; needs AI translation."
        table, column = ref
        table = _snake(table) if table else None
        column = _snake(column)
        if table and home_table and table != home_table:
            return None, None, None, f"{m.group(1)}If references another table ({table}); needs AI translation."
        filters, reason = translate_condition(condition, home_table)
        if reason:
            return None, None, None, reason
        return column, aggregate, filters, None

    m = _SIMPLE_AGG.match(expr)
    if m:
        func = m.group(1).lower()
        inner = m.group(2).strip()
        aggregate = _AGG_MAP.get(func, func)
        if func == "count" and not inner:
            return None, "count", None, None
        ref = parse_ref(inner)
        if ref is None:
            return None, None, None, f"Argument is not a single column reference: {inner!r}; needs AI translation."
        table, column = ref
        table = _snake(table) if table else None
        column = _snake(column)
        if table and home_table and table != home_table:
            return None, None, None, f"References another table ({table}); needs AI translation."
        return column, aggregate, None, None

    return None, None, None, f"Not a recognized clean aggregate wrapper: {expr!r}; needs AI translation."

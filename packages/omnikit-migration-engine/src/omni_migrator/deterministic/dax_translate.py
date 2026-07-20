"""Deterministic DAX -> Omni measure mapping (stage 1/3 of the sandwich, Appendix A.7-style).

Scope mirrors the Tableau calc-field handling and snowparser's AI-scoping lesson
(plan §12.2): translate only the *clean aggregate wrapper* shape deterministically;
everything else (row context, CALCULATE/FILTER, time intelligence, RELATED, nested
aggregates) is flagged `untranslatable` with the DAX text as the AI hint, not guessed.
"""

from __future__ import annotations

import re

# 'Table Name'[Column] or TableName[Column] -> (table, column)
_REF = re.compile(r"(?:'([^']+)'|([A-Za-z_][\w]*))\s*\[\s*([^\]]+?)\s*\]")
# FUNC ( <single-ref-arg> ) — the only deterministically-safe shape.
_WRAP = re.compile(
    r"^\s*(SUM|AVERAGE|MIN|MAX|MEDIAN|DISTINCTCOUNT|COUNT|COUNTROWS)\s*\((.*)\)\s*$",
    re.IGNORECASE | re.DOTALL,
)
_AGG_MAP = {
    "sum": "sum", "average": "average", "min": "min", "max": "max", "median": "median",
    "distinctcount": "count_distinct", "count": "count", "countrows": "count",
}
# any aggregate/iterator/CALCULATE-family token, used to detect nesting.
_AGG_ANY = re.compile(
    r"\b(SUM|SUMX|AVERAGE|AVERAGEX|MIN|MINX|MAX|MAXX|MEDIAN|MEDIANX|COUNT|COUNTX|COUNTROWS|"
    r"DISTINCTCOUNT|CALCULATE|CALCULATETABLE|FILTER|RELATED|RELATEDTABLE|VAR|SWITCH|IF)\s*\(",
    re.IGNORECASE,
)
# bare table reference, e.g. `'Orders'` or `Orders` (COUNTROWS argument).
_BARE_TABLE = re.compile(r"^\s*(?:'([^']+)'|([A-Za-z_][\w]*))\s*$")


def translate_measure(expression: str, home_table: str) -> tuple[str | None, str | None, str | None]:
    """Try to deterministically translate a DAX measure expression.

    Returns `(sql, aggregate, untranslatable_reason)` — exactly one of `(sql, aggregate)`
    or `untranslatable_reason` is set. `sql` is `None` for row-counting aggregates
    (COUNTROWS), matching Omni's count-of-rows convention.
    """
    expr = expression.strip()
    wrap = _WRAP.match(expr)
    if not wrap:
        return None, None, "Not a single clean aggregate wrapper; needs AI translation."

    func = wrap.group(1).lower()
    inner = wrap.group(2).strip()
    aggregate = _AGG_MAP[func]

    if func == "countrows":
        bare = _BARE_TABLE.match(inner)
        if not bare:
            return None, None, f"COUNTROWS argument is not a bare table reference: {inner!r}."
        table = bare.group(1) or bare.group(2)
        if table != home_table:
            return None, None, f"COUNTROWS references another table ({table}); needs AI translation."
        return None, "count", None

    if _AGG_ANY.search(inner):
        return None, None, "Nested aggregate/CALCULATE/iterator; needs AI translation."

    ref = _REF.match(inner)
    if not ref or ref.end() != len(inner):
        return None, None, f"Argument is not a single column reference: {inner!r}."
    table = ref.group(1) or ref.group(2)
    column = ref.group(3)
    if table != home_table:
        return None, None, f"References another table ({table}); needs AI translation (cross-table sql)."
    return column, aggregate, None  # bare column name — Omni has no ${TABLE} token

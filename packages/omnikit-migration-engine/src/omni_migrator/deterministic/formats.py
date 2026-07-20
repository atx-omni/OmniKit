"""Value-format mapping: source format strings -> Omni named `format` tokens.

See plan Appendix A.5. Unmapped inputs fall through as Excel-style strings verbatim
(Omni accepts e.g. '#,##0.00 "kg"').
"""

from __future__ import annotations

import re

# Looker built-in `value_format_name` values -> Omni token.
# Looker `usd` = $#,##0.00 (2dp); `usd_0` = $#,##0 (0dp); etc.
_LOOKER_NAMED: dict[str, str] = {
    "usd": "USDCURRENCY_2",
    "usd_0": "USDCURRENCY_0",
    "eur": "EURCURRENCY_2",
    "gbp": "GBPCURRENCY_2",
    "jpy": "JPYCURRENCY_0",
    "id": "ID",
    "percent_0": "PERCENT_0",
    "percent_1": "PERCENT_1",
    "percent_2": "PERCENT_2",
    "percent_3": "PERCENT_3",
    "decimal_0": "NUMBER_0",
    "decimal_1": "NUMBER_1",
    "decimal_2": "NUMBER_2",
    "decimal_3": "NUMBER_3",
}

# Excel-ish currency/percent heuristics for raw format strings (Tableau / Power BI).
_CURRENCY_SYMBOL = {"$": "USDCURRENCY", "€": "EURCURRENCY", "£": "GBPCURRENCY", "¥": "JPYCURRENCY"}


def _decimals_in(fmt: str) -> int:
    m = re.search(r"\.(0+)", fmt)
    return len(m.group(1)) if m else 0


def map_value_format(raw: str | None, *, source: str = "looker") -> str | None:
    """Return an Omni `format` token (or a verbatim Excel string) for a source format.

    `raw` is the source's format string/name. Returns None when there's nothing to set.
    """
    if not raw:
        return None
    key = raw.strip()
    if source == "looker" and key.lower() in _LOOKER_NAMED:
        return _LOOKER_NAMED[key.lower()]

    # Heuristic mapping for raw Excel-style strings (Tableau/Power BI/Looker custom).
    has_pct = "%" in key
    sym = next((s for s in _CURRENCY_SYMBOL if s in key), None)
    dp = _decimals_in(key)
    if has_pct:
        return f"PERCENT_{dp}"
    if sym:
        return f"{_CURRENCY_SYMBOL[sym]}_{dp}"
    if re.fullmatch(r"[#,0.]+", key):  # pure numeric mask
        return f"NUMBER_{dp}"
    # Unknown — pass the Excel-style string through verbatim.
    return key

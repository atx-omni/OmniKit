"""Resolve read-only source extractors from entry points or built-in fallbacks."""

from __future__ import annotations

from importlib.metadata import entry_points


def _load_group(group: str) -> dict[str, type]:
    found: dict[str, type] = {}
    try:
        for ep in entry_points(group=group):
            try:
                found[ep.name] = ep.load()
            except Exception:  # noqa: BLE001 - a broken plugin shouldn't kill discovery
                continue
    except Exception:  # noqa: BLE001
        pass
    return found


def get_extractor(name: str):
    extractors = _load_group("omni_migrator.extractors")
    if name not in extractors:
        # Fallback so the tool works from a source checkout before `pip install`.
        if name == "looker":
            from omni_migrator.extractors.looker.extractor import LookerExtractor

            return LookerExtractor()
        if name == "tableau":
            from omni_migrator.extractors.tableau.extractor import TableauExtractor

            return TableauExtractor()
        if name == "powerbi":
            from omni_migrator.extractors.powerbi.extractor import PowerBIExtractor

            return PowerBIExtractor()
        if name == "metabase":
            from omni_migrator.extractors.metabase.extractor import MetabaseExtractor

            return MetabaseExtractor()
        if name == "sigma":
            from omni_migrator.extractors.sigma.extractor import SigmaExtractor

            return SigmaExtractor()
        raise KeyError(f"Unknown extractor '{name}'. Available: {sorted(extractors)}")
    return extractors[name]()

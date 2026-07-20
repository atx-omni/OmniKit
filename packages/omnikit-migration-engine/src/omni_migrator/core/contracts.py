"""Read-only source extractor contracts for the OmniKit migration engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

from omni_migrator.ir.schema import MigrationBundle


@dataclass
class FileInput:
    paths: list[Path]


@dataclass
class ApiInput:
    base_url: str
    auth: dict = field(default_factory=dict)


ExtractorInput = FileInput | ApiInput


@dataclass
class ExtractCtx:
    """Optional knobs an extractor may honor (scoping, default schema, etc.)."""
    default_schema: str | None = None
    scope: dict = field(default_factory=dict)


@runtime_checkable
class Extractor(Protocol):
    source: str

    def detect(self, inp: ExtractorInput) -> bool: ...

    def extract(self, inp: ExtractorInput, ctx: ExtractCtx) -> MigrationBundle: ...

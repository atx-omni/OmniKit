from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from omni_migrator.core.archive_safety import (
    ArchiveSafetyLimits,
    read_zip_member_bounded,
    validate_zip_archive,
)


def _inspect(path: Path, limits: ArchiveSafetyLimits) -> tuple[zipfile.ZipInfo, ...]:
    with zipfile.ZipFile(path) as archive:
        return validate_zip_archive(archive, path.name, limits)


def test_valid_archive_passes_metadata_preflight_and_bounded_read(tmp_path: Path):
    path = tmp_path / "valid.twbx"
    content = b"<workbook><dashboard name='Example' /></workbook>"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("Workbook/example.twb", content)

    limits = ArchiveSafetyLimits(
        max_members=2,
        max_filename_bytes=64,
        max_member_uncompressed_bytes=128,
        max_total_uncompressed_bytes=128,
        max_expansion_ratio=2,
    )
    entries = _inspect(path, limits)
    with zipfile.ZipFile(path) as archive:
        assert read_zip_member_bounded(
            archive,
            entries[0],
            archive_name=path.name,
            max_bytes=128,
        ) == content


def test_archive_preflight_rejects_member_storm(tmp_path: Path):
    path = tmp_path / "members.twbx"
    with zipfile.ZipFile(path, "w") as archive:
        for index in range(4):
            archive.writestr(f"member-{index}.txt", b"x")

    with pytest.raises(ValueError, match="more than 3 entries"):
        _inspect(path, ArchiveSafetyLimits(max_members=3))


def test_archive_preflight_rejects_oversized_filename(tmp_path: Path):
    path = tmp_path / "filename.twbx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("abcdefghij.twb", b"<workbook />")

    with pytest.raises(ValueError, match="filename exceeds"):
        _inspect(path, ArchiveSafetyLimits(max_filename_bytes=8))


def test_archive_preflight_rejects_oversized_member_and_total(tmp_path: Path):
    member_path = tmp_path / "member.twbx"
    with zipfile.ZipFile(member_path, "w") as archive:
        archive.writestr("workbook.twb", b"123456789")
    with pytest.raises(ValueError, match="member expands"):
        _inspect(member_path, ArchiveSafetyLimits(max_member_uncompressed_bytes=8))

    total_path = tmp_path / "total.twbx"
    with zipfile.ZipFile(total_path, "w") as archive:
        archive.writestr("one.txt", b"123456")
        archive.writestr("two.txt", b"123456")
    with pytest.raises(ValueError, match="total byte limit"):
        _inspect(total_path, ArchiveSafetyLimits(max_total_uncompressed_bytes=10))


def test_archive_preflight_rejects_high_ratio_member(tmp_path: Path):
    path = tmp_path / "ratio.pbix"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("Report/Layout", b"0" * 16_384)

    with pytest.raises(ValueError, match="member expansion ratio"):
        _inspect(path, ArchiveSafetyLimits(max_expansion_ratio=2))


def test_archive_preflight_rejects_nested_migration_archive(tmp_path: Path):
    path = tmp_path / "nested.twbx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("Data/embedded.zip", b"not opened")

    with pytest.raises(ValueError, match="nested migration archives"):
        _inspect(path, ArchiveSafetyLimits())


def test_bounded_member_read_rechecks_actual_materialization_limit(tmp_path: Path):
    path = tmp_path / "bounded.pbix"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("Report/Layout", b"123456789")

    with zipfile.ZipFile(path) as archive:
        entry = archive.getinfo("Report/Layout")
        with pytest.raises(ValueError, match="parser byte limit"):
            read_zip_member_bounded(
                archive,
                entry,
                archive_name=path.name,
                max_bytes=8,
            )

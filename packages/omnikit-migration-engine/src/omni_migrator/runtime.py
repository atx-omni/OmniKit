"""Minimal read-only process boundary used by the OmniKit control plane."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from omni_migrator.bridge import bridge_capabilities, parse_and_execute_bridge_extract
from omni_migrator.conformance import CONFORMANCE_SOURCES, run_conformance
from omni_migrator.core.process_limits import apply_bridge_process_limits


def _compact_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="omnikit-migration-engine",
        description="Read-only source extraction for OmniKit BI Migration Studio.",
    )
    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("capabilities", help="Print supported read-only operations.")

    conformance = commands.add_parser(
        "conformance",
        help="Run deterministic, credential-free source conformance contracts.",
    )
    conformance.add_argument("--source", choices=CONFORMANCE_SOURCES)

    extract = commands.add_parser("extract", help="Run one bounded source extraction.")
    extract.add_argument(
        "--request",
        type=Path,
        help="Read the JSON request from a file instead of stdin.",
    )
    return parser


def _run_extract(request_path: Path | None) -> int:
    try:
        apply_bridge_process_limits()
        payload = request_path.read_text() if request_path else sys.stdin.read()
        sys.stdout.write(parse_and_execute_bridge_extract(payload))
        sys.stdout.write("\n")
        return 0
    except Exception as error:  # noqa: BLE001 - process boundary returns structured failures
        sys.stdout.write(_compact_json({
            "schema_version": "omnikit.migration.bundle.v1",
            "error": {
                "code": "bridge_extract_failed",
                "message": str(error),
                "retryable": False,
            },
        }))
        sys.stdout.write("\n")
        return 1


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.operation == "capabilities":
        sys.stdout.write(_compact_json(bridge_capabilities()))
        sys.stdout.write("\n")
        return 0
    if args.operation == "conformance":
        result = run_conformance(args.source)
        sys.stdout.write(_compact_json(result))
        sys.stdout.write("\n")
        return 0 if result["passed"] else 1
    if args.operation == "extract":
        return _run_extract(args.request)
    raise AssertionError(f"unsupported operation: {args.operation}")


if __name__ == "__main__":
    raise SystemExit(main())

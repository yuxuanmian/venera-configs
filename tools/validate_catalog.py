"""Validate the complete source catalog without executing source scripts."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
FILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*\.js$")
MAX_SOURCES = 256


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def validate_catalog(root: Path) -> list[str]:
    """Return all structural and syntax errors found in *root*."""

    errors: list[str] = []
    index_path = root / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return ["index.json: file does not exist"]
    except (OSError, json.JSONDecodeError) as exc:
        return [f"index.json: cannot read JSON: {exc}"]

    if not isinstance(index, list):
        return ["index.json: top-level value must be an array"]
    if len(index) > MAX_SOURCES:
        errors.append(f"index.json: more than {MAX_SOURCES} entries")

    keys: dict[str, int] = {}
    file_names: dict[str, int] = {}
    for number, entry in enumerate(index, 1):
        prefix = f"index.json entry {number}"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be an object")
            continue

        for field in ("name", "key", "fileName", "version"):
            if not _non_empty_string(entry.get(field)):
                errors.append(f"{prefix}: {field} must be a non-empty string")
        if "description" in entry and not isinstance(entry["description"], str):
            errors.append(f"{prefix}: description must be a string when present")

        key = entry.get("key")
        if isinstance(key, str):
            if not KEY_RE.fullmatch(key):
                errors.append(f"{prefix}: unsafe key {key!r}")
            elif key in keys:
                errors.append(f"{prefix}: duplicate key {key!r} (entry {keys[key]})")
            else:
                keys[key] = number

        file_name = entry.get("fileName")
        if isinstance(file_name, str):
            if (
                not FILE_RE.fullmatch(file_name)
                or "/" in file_name
                or "\\" in file_name
                or ".." in file_name.split("/")
                or any(ord(char) < 32 or ord(char) == 127 for char in file_name)
            ):
                errors.append(f"{prefix}: unsafe fileName {file_name!r}")
            else:
                folded = file_name.casefold()
                if folded in file_names:
                    errors.append(
                        f"{prefix}: fileName collides ignoring case with entry {file_names[folded]}"
                    )
                else:
                    file_names[folded] = number
                source_path = root / file_name
                if not source_path.is_file():
                    errors.append(f"{prefix}: source file does not exist: {file_name}")

    for number, entry in enumerate(index, 1):
        if not isinstance(entry, dict):
            continue
        file_name = entry.get("fileName")
        if not isinstance(file_name, str) or not FILE_RE.fullmatch(file_name):
            continue
        source_path = root / file_name
        if not source_path.is_file():
            continue
        try:
            result = subprocess.run(
                ["node", "--check", str(source_path)],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            errors.append(f"entry {number} ({file_name}): cannot run node --check: {exc}")
            continue
        if result.returncode:
            detail = (result.stderr or result.stdout).strip()
            errors.append(f"entry {number} ({file_name}): node --check failed: {detail}")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    errors = validate_catalog(args.root.resolve())
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"catalog validation passed: {args.root.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

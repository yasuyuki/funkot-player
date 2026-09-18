#!/usr/bin/env python3
"""Report Cargo updates permitted by this player's current manifest constraints.

This intentionally runs no write-capable Cargo command.  It requires the adopted,
clean sibling core checkout so that Cargo resolves the same path dependency as a
player build.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys


NETWORK_MARKERS = ("network", "download", "timeout", "timed out", "connection", "dns", "proxy")
UPDATE_LINE = re.compile(
    r"^\s*(?:Updating|Downgrading)\s+\S+\s+v\S+\s+->\s+v\S+|^\s*(?:Adding|Removing)\s+\S+\s+v\S+",
    re.MULTILINE,
)


def report(status: str, detail: str = "") -> None:
    line = f"cargo-update-check: {status}"
    if detail:
        line += f" — {detail}"
    print(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def append_summary_output(output: str) -> None:
    """Keep the complete candidate report available from an Actions run."""
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary and output:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("```text\n" + output.replace("```", "'''" ) + "\n```\n")


def snapshot_player(root: Path) -> dict[str, str]:
    """Hash only the player's Cargo inputs, without player Git metadata.

    This deliberately excludes generated Android trees (including local signing
    configuration) and frontend files: Cargo update only resolves the manifest,
    lockfile, configuration, build script, and Rust source inputs listed here.
    """
    result: dict[str, str] = {}
    for path in (
        root / "funkot-core.commit",
        root / ".cargo" / "config",
        root / ".cargo" / "config.toml",
        root / "src-tauri" / "Cargo.toml",
        root / "src-tauri" / "Cargo.lock",
        root / "src-tauri" / "build.rs",
        root / "src-tauri" / ".cargo" / "config",
        root / "src-tauri" / ".cargo" / "config.toml",
    ):
        if path.is_file():
            result[f"player/{path.relative_to(root)}"] = hashlib.sha256(path.read_bytes()).hexdigest()
    source = root / "src-tauri" / "src"
    for directory, subdirectories, filenames in os.walk(source):
        subdirectories[:] = [name for name in subdirectories if name != "target"]
        for filename in filenames:
            path = Path(directory) / filename
            if path.is_file():
                result[f"player/{path.relative_to(root)}"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def snapshot_tracked(repository: Path, label: str) -> dict[str, str]:
    """Hash the real core's tracked source, using its mounted Git metadata."""
    result: dict[str, str] = {}
    listed = subprocess.run(
        ["git", "-C", str(repository), "ls-files", "-z"], text=False, capture_output=True, check=True
    )
    for raw_path in listed.stdout.split(b"\0"):
        if not raw_path:
            continue
        relative = Path(os.fsdecode(raw_path))
        path = repository / relative
        if path.is_file():
            result[f"{label}/{relative}"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cargo", default="cargo", help="Cargo executable (default: cargo)")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    expected_core = (root.parent / "funkot-autodj-for-ui").resolve()
    configured_core = os.environ.get("FUNKOT_CORE_REPO")
    if os.environ.get("FUNKOT_CORE_CANDIDATE_SHA"):
        report("core failure", "candidate core overrides are not allowed for this official-pin check")
        return 20
    if configured_core and Path(configured_core).resolve() != expected_core:
        report("core failure", f"core must be the sibling {expected_core}")
        return 20

    check = root / "scripts" / "check-funkot-core-commit.sh"
    env = os.environ.copy()
    env.pop("FUNKOT_CORE_CANDIDATE_SHA", None)
    env["FUNKOT_CORE_REPO"] = str(expected_core)
    core = subprocess.run([str(check)], cwd=root, env=env, text=True, capture_output=True)
    if core.returncode:
        report("core failure", (core.stderr or core.stdout).strip().replace("\n", " "))
        return 20

    before = snapshot_player(root) | snapshot_tracked(expected_core, "core")
    command = [args.cargo, "update", "--manifest-path", "src-tauri/Cargo.toml", "--dry-run", "--color", "never"]
    try:
        cargo = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    except FileNotFoundError:
        report("tool failure", f"Cargo executable was not found: {args.cargo}")
        return 5
    after = snapshot_player(root) | snapshot_tracked(expected_core, "core")
    if before != after:
        changed = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
        report("mutation failure", "Cargo changed protected source, manifest, or lockfile: " + ", ".join(changed))
        return 21
    output = (cargo.stdout + cargo.stderr).strip()
    if cargo.returncode:
        lowered = output.lower()
        kind = "network failure" if any(marker in lowered for marker in NETWORK_MARKERS) else "resolution failure"
        report(kind, output.replace("\n", " "))
        return 4 if kind == "network failure" else 3
    updates = UPDATE_LINE.findall(cargo.stdout + cargo.stderr)
    if updates:
        report("candidates", "updates allowed by current manifest constraints")
        print(output)
        append_summary_output(output)
    else:
        report("none", "no updates allowed by current manifest constraints")
        if output:
            print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())

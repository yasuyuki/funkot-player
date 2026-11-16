#!/usr/bin/env python3
"""Run the output guard's exhaustive check and write summary.json."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "verification" / "output_guard"
PRODUCTION = ROOT / "src-tauri" / "src" / "output_guard.rs"
TESTS = [
    "proof::seal_maps_every_f32_into_full_scale_and_keeps_in_range_samples",
    "proof::the_wrapped_callback_leaves_only_full_scale_samples_for_every_f32",
]
STREAM_RE = re.compile(r"\.build_output_stream\s*\(")
GUARDED_RE = re.compile(r"\.build_output_stream\s*\(\s*config,\s*output_guard::guarded\(")
RESULT_RE = re.compile(
    r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;",
    re.M,
)


def compiler():
    version = subprocess.run(["rustc", "--version"], check=False, capture_output=True, text=True).stdout.strip()
    if version.startswith("rustc 1.93."):
        return ["cargo"], version
    pinned = subprocess.run(["rustc", "+1.93.0", "--version"], check=False, capture_output=True, text=True)
    if pinned.returncode == 0:
        return ["cargo", "+1.93.0"], pinned.stdout.strip()
    return None, version


def streams():
    """Every device stream under src-tauri, and whether its callback is wrapped."""
    found = {}
    for path in sorted((ROOT / "src-tauri").rglob("*.rs")):
        if "target" in path.relative_to(ROOT).parts:
            continue
        text = path.read_text(encoding="utf-8")
        opened = len(STREAM_RE.findall(text))
        if opened:
            found[path.relative_to(ROOT).as_posix()] = {
                "opened": opened, "guarded": len(GUARDED_RE.findall(text))}
    return found


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    summary = {"status": "FAIL", "errors": [], "tests": TESTS,
               "source": PRODUCTION.relative_to(ROOT).as_posix(),
               "source_sha256": hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()}
    errors = summary["errors"]
    for name in ("OUTPUT_GUARD_RS", "OUTPUT_GUARD_ALLOW_SUBSTITUTE"):
        if name in os.environ:
            errors.append(f"{name} is set; the official run checks the production file only")
    summary["streams"] = streams()
    if not summary["streams"]:
        errors.append("no build_output_stream call found; the stream moved and this check no longer sees it")
    for path, count in summary["streams"].items():
        if count["opened"] != count["guarded"]:
            errors.append(f"{path}: {count['opened']} device stream(s), {count['guarded']} wrapped in output_guard::guarded")
    cargo, summary["rustc"] = compiler()
    if cargo is None:
        errors.append(f"Rust 1.93 is required, found {summary['rustc'] or 'none'}")
    elif not errors:
        started = time.monotonic()
        run = subprocess.run(
            cargo + ["test", "--locked", "--manifest-path", str(PACKAGE / "Cargo.toml"), "--", "--test-threads=1"],
            check=False, capture_output=True, text=True,
            env={**os.environ, "CARGO_TERM_COLOR": "never",
                 "CARGO_TARGET_DIR": str((out or PACKAGE) / "target")})
        summary["seconds"] = round(time.monotonic() - started, 1)
        log = run.stdout + run.stderr
        if out:
            (out / "cargo.log").write_text(log, encoding="utf-8")
        # Cargo prints the unit tests of src/lib.rs first, then the empty doc-tests.
        block = run.stdout.split("\nrunning ", 2)
        block = block[1] if len(block) > 1 else ""
        result = RESULT_RE.search(block)
        for name in TESTS:
            if len(re.findall(rf"^test {re.escape(name)} \.\.\. ok$", block, re.M)) != 1:
                errors.append(f"{name} did not run once with ok")
        if not result or result.group(1) != "ok" or int(result.group(2)) != len(TESTS) or any(
                int(result.group(i)) for i in (3, 4, 6)):
            errors.append("the test summary is not exactly the listed tests, all passed")
        if run.returncode != 0:
            errors.append(f"cargo test exited {run.returncode}")
        compiled = re.findall(r"guard-source=(.+)", log)
        if not compiled or any(Path(item).resolve() != PRODUCTION for item in compiled):
            errors.append("the proof did not compile the production guard")
    if not errors:
        summary["status"] = "PASS"
    text = json.dumps(summary, indent=2) + "\n"
    if out:
        (out / "summary.json").write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())

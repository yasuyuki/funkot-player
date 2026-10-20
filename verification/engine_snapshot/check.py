#!/usr/bin/env python3
"""Run the engine snapshot Loom proof and write summary.json."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "verification" / "engine_snapshot"
PRODUCTION = ROOT / "src-tauri" / "src" / "engine_observation.rs"
TESTS = [
    "proof::index_and_finished_move_together",
    "proof::absent_current_hides_the_stale_index",
    "proof::reader_can_span_two_serialized_publishes",
    "proof::quiescent_publish_is_exactly_the_written_pair",
]


def fail(summary, message):
    summary["status"] = "FAIL"
    summary["error"] = message
    return summary


def compiler():
    current = subprocess.run(["rustc", "--version"], check=False, capture_output=True, text=True)
    version = current.stdout.strip()
    if version.startswith("rustc 1.93."):
        return ["cargo"], version, None
    pinned = subprocess.run(
        ["cargo", "+1.93.0", "--version"], check=False, capture_output=True, text=True)
    if pinned.returncode == 0:
        rustc = subprocess.run(
            ["rustc", "+1.93.0", "--version"], check=False, capture_output=True, text=True)
        return ["cargo", "+1.93.0"], rustc.stdout.strip(), None
    return None, version, f"Rust 1.93 is required, found {version or current.stderr.strip()}"


def main():
    results = Path(sys.argv[1] if len(sys.argv) > 1 else "/results")
    results.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    summary = {"status": "FAIL", "tests": TESTS, "loom": "0.7.2"}
    if os.environ.get("ENGINE_OBSERVATION_RS") or os.environ.get("ENGINE_OBSERVATION_ALLOW_SUBSTITUTE"):
        summary = fail(summary, "official run refuses a substituted observation file")
    else:
        cargo, rustc_version, compiler_error = compiler()
        summary["rustc"] = rustc_version
        summary["runner"] = os.environ.get("FUNKOT_SNAPSHOT_RUNNER", "host")
        if compiler_error:
            summary = fail(summary, compiler_error)
        else:
            env = os.environ.copy()
            env.pop("ENGINE_OBSERVATION_RS", None)
            env.pop("ENGINE_OBSERVATION_ALLOW_SUBSTITUTE", None)
            env["CARGO_TARGET_DIR"] = "/tmp/funkot-engine-snapshot-target"
            log_path = results / "cargo.log"
            command = [*cargo, "test", "--locked", "--manifest-path",
                       str(PACKAGE / "Cargo.toml"), "--", "--test-threads=1"]
            with log_path.open("w") as log:
                process = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            log_text = log_path.read_text()
            marker = "observation-source="
            observed = [line.split(marker, 1)[1].strip() for line in log_text.splitlines() if marker in line]
            production = PRODUCTION.resolve()
            summary["source_sha256"] = hashlib.sha256(production.read_bytes()).hexdigest()
            if process.returncode != 0:
                summary = fail(summary, f"cargo exited {process.returncode}")
                summary["log_tail"] = "\n".join(log_text.splitlines()[-40:])
            elif len(observed) != 1 or Path(observed[0]).resolve() != production:
                summary = fail(summary, f"proof did not compile the production module: {observed}")
            else:
                summary.update(status="PASS", source=str(production))
    summary["wall_seconds"] = round(time.monotonic() - started, 3)
    (results / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())

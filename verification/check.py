"""Check the fixed Kani result, including execution and reachable cover checks."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

EXPECTED = {"proofs::occurrence_update": 8, "proofs::initial_and_seven_occurrences": 2}
started = time.monotonic()
result = Path("/results")
command = ["kani", "verification/playlist_progress.rs", "--target-dir", "/tmp/kani-proof",
           "-j", "1", "--output-format", "terse", "-Z", "unstable-options",
           "--export-json", str(result / "kani.json")]
# The container limit covers the compiler, verifier and all solver processes.
limit = int(Path("/sys/fs/cgroup/memory.max").read_text())
assert 0 < limit <= 8 * 1024**3, "verification requires a total 8 GiB cgroup limit"
with (result / "kani.log").open("w") as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        status = process.wait(timeout=15 * 60)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        status = 124
elapsed = time.monotonic() - started
peak = int(Path("/sys/fs/cgroup/memory.peak").read_text())
summary = {"status": "FAIL", "exit_code": status, "wall_seconds": round(elapsed, 3),
           "peak_bytes": peak, "limit_bytes": limit}
try:
    assert status == 0, f"Kani exited {status} (timeout/resource/verification failure is not PASS)"
    data = json.loads((result / "kani.json").read_text())
    assert data["tools"]["kani"] == "0.68.0", "unexpected verifier version"
    assert data["tools"]["rustc"] == "rustc 1.100.0-nightly (8925ea358 2026-08-20)", "unexpected bundled Rust"
    verification = data["verification_results"]
    assert verification["summary"]["status"] == "completed"
    assert verification["summary"]["executed"] == len(EXPECTED)
    results = verification["results"]
    assert len(results) == len(EXPECTED)
    assert {r["harness_id"] for r in results} == set(EXPECTED), "missing/extra harness"
    for r in results:
        assert r["status"] == "Success", r["harness_id"]
        checks = r["checks"]
        covers = [c for c in checks if c["category"] == "cover"]
        assert len(covers) == EXPECTED[r["harness_id"]]
        assert all(c["status"] == "Satisfied" for c in covers), "unreachable cover"
        assert all(c["status"] in {"Success", "Unreachable", "Satisfied"} for c in checks)
    summary.update(status="PASS", tools=data["tools"], harnesses=EXPECTED)
except (AssertionError, KeyError, ValueError, OSError) as error:
    summary["error"] = str(error)
    print((result / "kani.log").read_text())
(result / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
sys.exit(0 if summary["status"] == "PASS" else 1)

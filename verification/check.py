"""Check fixed Kani results, including execution and reachable cover checks."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

PROOFS = {
    "playlist_progress": {
        "proofs::occurrence_update": 8,
        "proofs::initial_and_seven_occurrences": 2,
    },
    "queue_progress": {
        "proofs::membership_update": 10,
        "proofs::distinct_occurrences": 2,
        "proofs::automatic_fill_requires_exhausted_selection": 3,
    },
}
started = time.monotonic()
result = Path("/results")
# The container limit covers the compiler, verifier and all solver processes.
limit = int(Path("/sys/fs/cgroup/memory.max").read_text())
assert 0 < limit <= 8 * 1024**3, "verification requires a total 8 GiB cgroup limit"
summary = {"status": "FAIL", "limit_bytes": limit, "proofs": {}}
log_path = None
try:
    for name, expected in PROOFS.items():
        stem = "kani" if name == "playlist_progress" else "queue-kani"
        log_path = result / f"{stem}.log"
        json_path = result / f"{stem}.json"
        command = ["kani", f"verification/{name}.rs", "--target-dir", f"/tmp/kani-{name}",
                   "-j", "1", "--output-format", "terse", "-Z", "unstable-options",
                   "--export-json", str(json_path)]
        with log_path.open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                status = process.wait(timeout=max(0, 15 * 60 - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                status = 124
        summary["exit_code"] = status
        assert status == 0, f"{name}: Kani exited {status} (timeout/resource/verification failure is not PASS)"
        data = json.loads(json_path.read_text())
        assert data["tools"]["kani"] == "0.68.0", "unexpected verifier version"
        assert data["tools"]["rustc"] == "rustc 1.100.0-nightly (8925ea358 2026-08-20)", "unexpected bundled Rust"
        verification = data["verification_results"]
        assert verification["summary"]["status"] == "completed"
        assert verification["summary"]["executed"] == len(expected)
        results = verification["results"]
        assert len(results) == len(expected)
        assert {r["harness_id"] for r in results} == set(expected), "missing/extra harness"
        for r in results:
            assert r["status"] == "Success", r["harness_id"]
            checks = r["checks"]
            covers = [c for c in checks if c["category"] == "cover"]
            assert len(covers) == expected[r["harness_id"]]
            assert all(c["status"] == "Satisfied" for c in covers), "unreachable cover"
            assert all(c["status"] in {"Success", "Unreachable", "Satisfied"} for c in checks)
        summary["proofs"][name] = expected
        summary["tools"] = data["tools"]
    summary.update(status="PASS", harnesses={key: value for proof in PROOFS.values()
                                           for key, value in proof.items()})
except (AssertionError, KeyError, ValueError, OSError) as error:
    summary["error"] = str(error)
    if log_path is not None and log_path.exists():
        print(log_path.read_text())
summary.update(wall_seconds=round(time.monotonic() - started, 3),
               peak_bytes=int(Path("/sys/fs/cgroup/memory.peak").read_text()))
(result / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
sys.exit(0 if summary["status"] == "PASS" else 1)
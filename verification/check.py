"""Check fixed Kani results, including execution and reachable cover checks."""
import json
import os
from pathlib import Path
import signal
import hashlib
import tempfile
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
    "playback_recovery": {
        "proofs::classifies_legacy_normal_import": 5,
        "proofs::restores_missing_normal_current_identity": 5,
    },
}
started = time.monotonic()
result = Path("/results")
limit = int(Path("/sys/fs/cgroup/memory.max").read_text())
assert 0 < limit <= 8 * 1024**3, "verification requires a total 8 GiB cgroup limit"
summary = {"status": "FAIL", "limit_bytes": limit, "proofs": {}}
log_path = None
try:
    for name, expected in PROOFS.items():
        stem = {
            "playlist_progress": "kani",
            "queue_progress": "queue-kani",
            "playback_recovery": "recovery-kani",
        }[name]
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
    summary["sensitivity"] = {}
    mutations = (
        ("playlist_progress", "playlist_progress", "proofs::occurrence_update",
         "Observation::Passive => None,", "Observation::Passive => Some(Cause::Started),"),
        ("queue_progress", "queue_progress", "proofs::membership_update",
         "None => present,", "None => false,"),
        ("playback_recovery_identity", "playback_recovery",
         "proofs::restores_missing_normal_current_identity",
         "if !normal || existing.is_some() {", "if !normal {"),
        ("playback_recovery_classifier", "playback_recovery",
         "proofs::classifies_legacy_normal_import",
         "(Some(_), Some(_)) => LegacyNormalImport::Conflict,",
         "(Some(_), Some(_)) => LegacyNormalImport::UseCatalog,"),
    )
    for label, name, harness, original, broken in mutations:
        source = Path(f"src-tauri/src/{name}.rs")
        text = source.read_text()
        assert text.count(original) == 1, f"{name}: sensitivity edit no longer matches production"
        with tempfile.TemporaryDirectory(prefix=f"kani-sensitivity-{label}-") as temporary:
            tree = Path(temporary)
            (tree / "verification").mkdir()
            (tree / "src-tauri/src").mkdir(parents=True)
            (tree / f"verification/{name}.rs").write_bytes(Path(f"verification/{name}.rs").read_bytes())
            (tree / f"src-tauri/src/{name}.rs").write_text(text.replace(original, broken))
            log_path = result / f"{label}-sensitivity.log"
            json_path = result / f"{label}-sensitivity.json"
            json_path.unlink(missing_ok=True)
            command = ["kani", f"verification/{name}.rs", "--harness", harness,
                       "--target-dir", str(tree / "target"), "-j", "1",
                       "--output-format", "terse", "-Z", "unstable-options",
                       "--export-json", str(json_path)]
            with log_path.open("w") as log:
                process = subprocess.Popen(command, cwd=tree, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                try:
                    status = process.wait(timeout=max(0, 15 * 60 - (time.monotonic() - started)))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    status = 124
            assert status not in (0, 124), f"{name}: mutation passed or timed out"
            data = json.loads(json_path.read_text())
            verification = data["verification_results"]
            assert verification["summary"]["status"] == "completed"
            results = verification["results"]
            assert verification["summary"]["executed"] == 1
            assert len(results) == 1 and results[0]["harness_id"] == harness
            assert results[0]["status"] == "Failure", f"{name}: no verified counterexample"
            assert any(check["status"] == "Failure" and check["category"] == "assertion"
                       for check in results[0]["checks"]), f"{name}: no failing safety assertion"
            summary["sensitivity"][label] = {
                "status": "EXPECTED_FAIL", "harness": harness,
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
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

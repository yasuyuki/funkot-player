#!/usr/bin/env python3
"""Run the engine snapshot Loom proof and write summary.json."""
import hashlib
import json
import os
from pathlib import Path
import re
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
# Production and test publishes of this snapshot. A different set fails the run.
WRITER_COUNTS = {
    "src-tauri/src/lib.rs": 4,
    "src-tauri/src/playlist_service.rs": 6,
    "src-tauri/src/engine_observation.rs": 2,
    "src-tauri/src/playlist_service/tests.rs": 2,
}
COVERED = (
    "src-tauri/src/engine_observation.rs",
    "verification/engine_snapshot/",
    "scripts/check-engine-snapshot.sh",
    ".claude/skills/verify-engine-snapshot/",
)
PUBLISH_RE = re.compile(r"publish_engine_observation\s*\(|observation\.publish\s*\(")
LOCK_RE = re.compile(r"\.lock\(|try_lock\(|fn publish_engine_observation\b|fn resume_finished_engine\b")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
RESULT_RE = re.compile(
    r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;",
    re.M,
)
LOOM_ENV = (
    "LOOM_MAX_PREEMPTIONS",
    "LOOM_MAX_PERMUTATIONS",
    "LOOM_MAX_DURATION",
    "LOOM_MAX_BRANCHES",
    "LOOM_CHECKPOINT_FILE",
)


def fail(summary, message):
    summary["status"] = "FAIL"
    summary.setdefault("errors", []).append(message)
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


def clean_log(text):
    return ANSI_RE.sub("", text)


def unittest_block(log_text):
    marker = "Running unittests src/lib.rs"
    start = log_text.find(marker)
    if start < 0:
        return None
    rest = log_text[start:]
    end = rest.find("\n   Doc-tests ")
    return rest if end < 0 else rest[:end]


def judge_unittests(log_text):
    block = unittest_block(clean_log(log_text))
    if block is None:
        return "lib test block is absent"
    outcomes = re.findall(r"^test (\S+) \.\.\. (ok|FAILED|ignored)$", block, re.M)
    running = re.findall(r"^running (\d+) tests?$", block, re.M)
    results = RESULT_RE.findall(block)
    if len(running) != 1 or len(results) != 1:
        return "lib test summary is missing or repeated"
    ran = int(running[0])
    status, passed, failed_n, ignored, measured, filtered = results[0]
    counts = (int(passed), int(failed_n), int(ignored), int(measured), int(filtered))
    found = {name: outcome for name, outcome in outcomes}
    missing = [name for name in TESTS if found.get(name) != "ok"]
    if missing:
        return f"missing or unsuccessful tests: {', '.join(missing)}"
    if ran != len(outcomes) or counts != (ran, 0, 0, 0, 0) or status != "ok":
        return (
            f"lib tests ran {ran}, result {status} "
            f"{counts[0]} passed, {counts[1]} failed, {counts[2]} ignored, "
            f"{counts[3]} measured, {counts[4]} filtered"
        )
    return None


def scan_writers(root):
    counts = {}
    base = root / "src-tauri"
    if not base.is_dir():
        return counts
    for path in base.rglob("*.rs"):
        if "target" in path.parts:
            continue
        count = len(PUBLISH_RE.findall(path.read_text(errors="replace")))
        if count:
            counts[path.relative_to(root).as_posix()] = count
    return counts


def judge_writers(root):
    found = scan_writers(root)
    if found != WRITER_COUNTS:
        return (
            "writer set differs from the recorded mutex review: "
            f"found {found}. Re-read each publish. A PASS of the seqlock does not "
            "accept a new or removed writer. Update WRITER_COUNTS only after that read."
        )
    return None


def covered(path):
    for item in COVERED:
        if item.endswith("/"):
            if path.startswith(item):
                return True
        elif path == item:
            return True
    return False


def name_status_rows(text):
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        rows.append((parts[0], parts[1:]))
    return rows


def parse_name_status(text):
    paths = []
    for _, row_paths in name_status_rows(text):
        paths.extend(row_paths)
    return paths


def parse_diff(diff):
    path = None
    hunks = []
    publish_edits = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            path = line.split(" b/", 1)[-1]
        elif line.startswith("@@"):
            match = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if match and path:
                start = int(match.group(1))
                length = int(match.group(2) or "1")
                hunks.append((path, start, start + max(length, 1) - 1))
        elif path and (line.startswith("+") or line.startswith("-")) and not line.startswith(("+++", "---")):
            if PUBLISH_RE.search(line[1:]):
                publish_edits.append(path)
    return hunks, publish_edits


def publish_spans(text):
    lines = text.splitlines()
    spans = []
    for index, line in enumerate(lines, 1):
        if not PUBLISH_RE.search(line):
            continue
        start = index
        for earlier in range(index - 1, max(0, index - 200), -1):
            if LOCK_RE.search(lines[earlier - 1]):
                start = earlier
                break
        spans.append((start, index))
    return spans


def decide(name_status, unified_diff, files, old_files=None):
    reasons = []
    review = []
    for status, paths in name_status_rows(name_status):
        for path in paths:
            if covered(path):
                reasons.append(f"covered path {path}")
            if path in WRITER_COUNTS and status[:1] in "RDC":
                message = f"recorded writer path {status} {path}"
                reasons.append(message)
                review.append(message)
    hunks, publish_edits = parse_diff(unified_diff)
    for path in publish_edits:
        if not path.endswith(".rs"):
            continue
        reasons.append(f"publish call edited in {path}")
        review.append(f"publish call edited in {path}")
    sources = [files]
    if old_files:
        sources.append(old_files)
    spans = [
        {path: publish_spans(text) for path, text in source.items() if path.endswith(".rs")}
        for source in sources
    ]
    for path, start, end in hunks:
        for span_set in spans:
            for span_start, span_end in span_set.get(path, []):
                if start <= span_end and end >= span_start:
                    message = f"edit inside writer span {path}:{span_start}-{span_end}"
                    reasons.append(message)
                    review.append(message)
                    break
    return {
        "proof_required": bool(reasons),
        "assumption_review": bool(review),
        "reasons": list(dict.fromkeys(reasons)),
    }


def self_test(verbose=False):
    condition = "\n".join([
        "diff --git a/src-tauri/src/engine_observation.rs b/src-tauri/src/engine_observation.rs",
        "@@ -53 +53 @@",
        "-(before == after)",
        "+(before % 2 == 0)",
    ])
    renamed = decide(
        "R100\tsrc-tauri/src/engine_observation.rs\tsrc-tauri/src/snapshot_gate.rs",
        "",
        {},
    )
    assert renamed["proof_required"]
    moved_writer = decide(
        "R100\tsrc-tauri/src/playlist_service.rs\tsrc-tauri/src/playback_publish.rs",
        "",
        {},
    )
    assert moved_writer["proof_required"] and moved_writer["assumption_review"]
    added = "\n".join([
        "diff --git a/src-tauri/src/side.rs b/src-tauri/src/side.rs",
        "@@ -1 +1 @@",
        "+observation.publish(None, true);",
    ])
    assert decide("A\tsrc-tauri/src/side.rs", added, {})["proof_required"]
    assert not decide("M\tsrc/App.tsx", "@@ -1 +1 @@\n-let x = 1;\n+let x = 2;\n", {})["proof_required"]
    old = "\n".join([
        "fn open() {",
        "    let guard = render.try_lock();",
        "    let middle = 0;",
        "    observation.publish(current, finished);",
        "}",
    ])
    new = old.replace("let guard = render.try_lock();", "let guard = ();")
    lock_edit = "\n".join([
        "diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs",
        "@@ -2 +2 @@",
        "-    let guard = render.try_lock();",
        "+    let guard = ();",
    ])
    lock_decision = decide(
        "M\tsrc-tauri/src/lib.rs", lock_edit,
        {"src-tauri/src/lib.rs": new}, {"src-tauri/src/lib.rs": old})
    assert lock_decision["proof_required"] and lock_decision["assumption_review"]
    condition_decision = decide("M\tsrc-tauri/src/engine_observation.rs", condition, {})
    assert condition_decision["proof_required"] and not condition_decision["assumption_review"]
    far = "\n".join([
        "diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs",
        "@@ -80 +80 @@",
        "-let color = 1;",
        "+let color = 2;",
    ])
    assert not decide("M\tsrc-tauri/src/lib.rs", far, {"src-tauri/src/lib.rs": old + "\n" * 80})["proof_required"]
    filtered = "\n".join([
        "     Running unittests src/lib.rs (example)",
        "",
        "running 1 test",
        "test proof::quiescent_publish_is_exactly_the_written_pair ... ok",
        "",
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s",
        "",
        "   Doc-tests engine_snapshot_proof",
        "",
        "running 0 tests",
        "",
        "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    ])
    assert judge_unittests(filtered)
    absent = filtered.replace("running 1 test", "running 0 tests").replace(
        "test proof::quiescent_publish_is_exactly_the_written_pair ... ok\n\n", "")
    absent = absent.replace(
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s",
        "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    )
    assert judge_unittests(absent)
    ok_lines = "\n".join([f"test {name} ... ok" for name in TESTS])
    passed = "\n".join([
        "     Running unittests src/lib.rs (example)",
        "",
        "running 4 tests",
        ok_lines,
        "",
        "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s",
        "",
        "   Doc-tests engine_snapshot_proof",
        "",
        "running 0 tests",
        "",
        "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    ])
    assert judge_unittests(passed) is None
    assert judge_unittests(passed.replace(" ... ok", " ... ignored", 1))
    if verbose:
        print("condition-only covered file: required")
        print("rename of engine_observation.rs: required")
        print("rename of a recorded writer file: required")
        print("new observation.publish file: required")
        print("unrelated UI file: not required")
        print("lock deletion beside a publish: required")
        print("filtered and zero-test logs: rejected")


def git_text(args):
    result = subprocess.run(["git", *args], cwd=ROOT, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def show_file(rev, path):
    try:
        return git_text(["show", f"{rev}:{path}"])
    except RuntimeError:
        return None


def applies():
    base = "HEAD"
    if "--base" in sys.argv:
        index = sys.argv.index("--base")
        if index + 1 >= len(sys.argv):
            raise RuntimeError("--base needs a revision")
        base = sys.argv[index + 1]
    chunks = []
    name_parts = []
    diffs = [
        ["diff", "--name-status", "-M"],
        ["diff", "--cached", "--name-status", "-M"],
        ["diff", "-U0", "-M"],
        ["diff", "--cached", "-U0", "-M"],
    ]
    if base != "HEAD":
        diffs.extend([
            ["diff", "--name-status", "-M", f"{base}...HEAD"],
            ["diff", "-U0", "-M", f"{base}...HEAD"],
        ])
    for args in diffs:
        text = git_text(args)
        if "--name-status" in args:
            name_parts.append(text)
        else:
            chunks.append(text)
    untracked = git_text(["ls-files", "--others", "--exclude-standard"])
    extra_names = []
    for path in untracked.splitlines():
        extra_names.append(f"??\t{path}")
        file_path = ROOT / path
        if path.endswith(".rs") and file_path.is_file() and PUBLISH_RE.search(file_path.read_text(errors="replace")):
            chunks.append(f"diff --git a/{path} b/{path}\n@@ -1 +1 @@\n+observation.publish();\n")
    paths = parse_name_status("\n".join(name_parts))
    files = {}
    old_files = {}
    for path in paths:
        file_path = ROOT / path
        if file_path.is_file():
            files[path] = file_path.read_text(errors="replace")
        elif base != "HEAD":
            current = show_file("HEAD", path)
            if current is not None:
                files[path] = current
        previous = show_file(base if base != "HEAD" else "HEAD", path)
        if previous is not None:
            old_files[path] = previous
    decision = decide("\n".join(name_parts + extra_names), "\n".join(chunks), files, old_files)
    print(json.dumps(decision))
    return 0 if decision["proof_required"] else 3


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test(verbose=True)
        print("self-test ok")
        return 0
    if len(sys.argv) > 1 and sys.argv[1] == "--applies":
        return applies()
    results = Path(sys.argv[1] if len(sys.argv) > 1 else "/results")
    results.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    summary = {"tests": TESTS, "loom": "0.7.2"}
    try:
        self_test()
    except AssertionError as error:
        summary = fail(summary, f"trigger self-test failed: {error}")
    substituted = os.environ.get("ENGINE_OBSERVATION_RS") or os.environ.get("ENGINE_OBSERVATION_ALLOW_SUBSTITUTE")
    if substituted:
        summary = fail(summary, "official run refuses a substituted observation file")
    loom_env = {name: os.environ[name] for name in LOOM_ENV if name in os.environ}
    if loom_env:
        summary = fail(summary, f"Loom exploration variables change the proof bounds: {sorted(loom_env)}")
    writer_error = judge_writers(ROOT)
    if writer_error:
        summary = fail(summary, writer_error)
    cargo, rustc_version, compiler_error = compiler()
    summary["rustc"] = rustc_version
    summary["runner"] = os.environ.get("FUNKOT_SNAPSHOT_RUNNER", "host")
    if compiler_error:
        summary = fail(summary, compiler_error)
    blocked = summary.get("errors")
    if not blocked:
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
        test_error = judge_unittests(log_text)
        if process.returncode != 0:
            summary = fail(summary, f"cargo exited {process.returncode}")
            summary["log_tail"] = "\n".join(clean_log(log_text).splitlines()[-40:])
        if test_error:
            summary = fail(summary, test_error)
        if len(observed) != 1 or Path(observed[0]).resolve() != production:
            summary = fail(summary, f"proof did not compile the production module: {observed}")
        if not summary.get("errors"):
            summary.update(status="PASS", source=str(production))
    if summary.get("errors"):
        summary["status"] = "FAIL"
    summary["wall_seconds"] = round(time.monotonic() - started, 3)
    (results / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(json.dumps({"proof_required": True, "error": str(error)}))
        sys.exit(1)

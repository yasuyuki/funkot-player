"""Check the bounded source-switch model against archived player and core revisions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
TLC_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
PLAYER_SOURCES = (
    "funkot-core.commit",
    "src-tauri/src/playlist_service.rs",
    "src-tauri/src/playback_state.rs",
    "src-tauri/src/playback_recovery.rs",
    "src-tauri/src/playlists.rs",
    "src-tauri/src/queue_progress.rs",
    "src-tauri/src/playlist_progress.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/queue.rs",
    "src-tauri/src/store.rs",
    "src-tauri/src/playlist_service/tests.rs",
    "verification/source_switch/SourceSwitch.tla",
    "verification/source_switch/SourceSwitch.cfg",
    "verification/check_source_switch.py",
)
CORE_SOURCES = ("funkot-core/src/engine.rs",)
MUTATIONS = (
    (
        "stale_epoch",
        "CheckEpoch = TRUE",
        "CheckEpoch = FALSE",
        "Invariant NoStaleLoaderEffect is violated",
    ),
    (
        "missing_fence",
        "UseFence = TRUE",
        "UseFence = FALSE",
        "Invariant FenceBeforeFutureDelta is violated",
    ),
    (
        "commit_after_failure",
        "CommitOnFailure = FALSE",
        "CommitOnFailure = TRUE",
        "Invariant NoCommitWithoutDurableCandidate is violated",
    ),
)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected_core_root(player_root):
    manifest = player_root.parent / "WORKING-SET.json"
    try:
        manifest_exists = manifest.exists()
    except OSError as error:
        raise RuntimeError("cannot inspect the selected working set") from error
    if not manifest_exists:
        return (player_root.parent / "funkot-autodj-for-ui").resolve()
    try:
        members = json.loads(manifest.read_text())["members"]
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError("cannot read the selected working set") from error
    by_name = {member.get("name"): member.get("path") for member in members if isinstance(member, dict)}
    player_path = by_name.get("funkot-player")
    core_path = by_name.get("funkot-autodj-for-ui")
    if not isinstance(player_path, str) or not isinstance(core_path, str):
        raise RuntimeError("selected working set does not declare player and core members")
    if (player_root.parent / player_path).resolve() != player_root.resolve():
        raise RuntimeError("runner is not located in the selected player member")
    return (player_root.parent / core_path).resolve()


def source_revision(root, label):
    try:
        revision = subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "--verify", "HEAD^{commit}"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"cannot resolve {label} HEAD commit") from error
    if re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", revision) is None:
        raise RuntimeError(f"invalid {label} revision")
    try:
        dirty = subprocess.check_output(
            ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=normal"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"cannot inspect {label} status") from error
    if dirty:
        raise RuntimeError(f"{label} checkout is dirty; commit owned changes before verification")
    return revision


def read_core_pin(player_root):
    try:
        pin = (player_root / "funkot-core.commit").read_text().strip()
    except OSError as error:
        raise RuntimeError("cannot read player funkot-core.commit") from error
    if re.fullmatch(r"[0-9a-f]{40}", pin) is None:
        raise RuntimeError("player funkot-core.commit must contain one lowercase 40-character commit")
    return pin


def source_provenance(player_root, core_root):
    player_revision = source_revision(player_root, "player")
    core_revision = source_revision(core_root, "core")
    pin = read_core_pin(player_root)
    if core_revision != pin:
        raise RuntimeError("player funkot-core.commit does not match the selected core HEAD")
    return player_revision, core_revision


def archive_commit(root, revision, destination, label):
    archive = subprocess.Popen(
        ["git", "-C", str(root), "archive", "--format=tar", revision],
        stdout=subprocess.PIPE,
    )
    try:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as source:
            source.extractall(destination, filter="data")
    except (OSError, tarfile.TarError) as error:
        archive.kill()
        archive.wait()
        raise RuntimeError(f"cannot archive the resolved {label} commit") from error
    if archive.wait() != 0:
        raise RuntimeError(f"cannot archive the resolved {label} commit")


def run_tlc(tree, out, java, jar, label, cfg, started, violation=None,
            spec="verification/source_switch/SourceSwitch.tla"):
    remaining = 15 * 60 - (time.monotonic() - started)
    if remaining <= 0:
        raise RuntimeError(label + ": total verification deadline exceeded")
    directory = (tree / spec).parent
    config = directory / (label + ".cfg")
    config.write_text(cfg)
    command = [
        java,
        "-XX:MaxRAM=8g",
        "-XX:+UseParallelGC",
        "-cp",
        str(jar),
        "tlc2.TLC",
        "-workers",
        "auto" if violation is None else "1",
        "-seed",
        "0",
        "-fp",
        "0",
        "-config",
        config.name,
        "-metadir",
        str(tree / ("states-" + label)),
        Path(spec).name,
    ]
    log_path = out / (label + ".log")
    with log_path.open("w") as log:
        process = subprocess.Popen(
            command,
            cwd=directory,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            status = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RuntimeError(label + ": total verification deadline exceeded")
    if time.monotonic() - started > 15 * 60:
        raise RuntimeError(label + ": total verification deadline exceeded")
    log = log_path.read_text()
    counts = re.findall(
        r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue",
        log,
    )
    if not counts:
        raise RuntimeError(label + ": TLC produced no state counts")
    generated, distinct, pending = (
        int(value.replace(",", "")) for value in counts[-1]
    )
    if not (generated >= distinct > 0):
        raise RuntimeError(label + ": invalid state counts")
    if violation is None:
        if (
            status != 0
            or pending != 0
            or "Model checking completed. No error has been found." not in log
        ):
            raise RuntimeError(label + ": TLC did not finish the complete safety check")
    elif status != 12 or violation not in log or "State 1:" not in log:
        raise RuntimeError(label + ": missing the required checked counterexample")
    print(label + (" PASS" if violation is None else " EXPECTED_FAIL"), flush=True)
    return {
        "status": "PASS" if violation is None else "EXPECTED_FAIL",
        "exit_code": status,
        "generated": generated,
        "distinct": distinct,
        "pending": pending,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", action="store_true", help="download the fixed TLC jar and check its hash")
    parser.add_argument(
        "--jar",
        type=Path,
        default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        / "funkot-verification/tla2tools-1.7.4.jar",
    )
    parser.add_argument("--java", default="java", help="Java 21 executable")
    parser.add_argument("--output", type=Path, help="new or empty evidence directory")
    args = parser.parse_args()
    if args.setup:
        args.jar.parent.mkdir(parents=True, exist_ok=True)
        if not args.jar.exists():
            with tempfile.NamedTemporaryFile(dir=args.jar.parent, delete=False) as temporary:
                temporary_path = Path(temporary.name)
                with urllib.request.urlopen(TLC_URL) as response:
                    temporary.write(response.read())
            if sha256(temporary_path) != TLC_SHA256:
                raise RuntimeError("downloaded TLC jar does not match the fixed hash")
            temporary_path.replace(args.jar)
        if sha256(args.jar) != TLC_SHA256:
            raise RuntimeError("TLC jar does not match the fixed hash")
        print("TLC 1.7.4 ready")
        return 0

    player_root = Path(__file__).resolve().parents[1]
    out = args.output or Path(tempfile.mkdtemp(prefix="source-switch-proof-"))
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error("evidence directory is not empty; prior evidence is unchanged and no proof ran")
    summary = {"status": "FAIL"}
    summary_path = out / "summary.json"
    summary_path.write_text(json.dumps(summary) + "\n")
    started = time.monotonic()
    try:
        core_root = selected_core_root(player_root)
        player_revision, core_revision = source_provenance(player_root, core_root)
        summary["revision"] = player_revision
        summary["core_revision"] = core_revision
        jar = args.jar.resolve(strict=True)
        if sha256(jar) != TLC_SHA256:
            raise RuntimeError("TLC jar does not match the fixed hash")
        java_version = subprocess.check_output(
            [args.java, "-version"], stderr=subprocess.STDOUT, text=True
        )
        if re.search(r'version "21[."]', java_version) is None:
            raise RuntimeError("Java 21 is required")
        summary["tools"] = {
            "tlc": "1.7.4",
            "jar_sha256": TLC_SHA256,
            "java": java_version.splitlines()[0],
        }
        with tempfile.TemporaryDirectory(prefix="source-switch-player-") as player_temporary, tempfile.TemporaryDirectory(prefix="source-switch-core-") as core_temporary:
            player_tree = Path(player_temporary)
            core_tree = Path(core_temporary)
            archive_commit(player_root, player_revision, player_tree, "player")
            archive_commit(core_root, core_revision, core_tree, "core")
            archived_pin = read_core_pin(player_tree)
            if archived_pin != core_revision:
                raise RuntimeError("archived player core pin does not match the archived core revision")
            summary["sources"] = {
                **{"player/" + name: sha256(player_tree / name) for name in PLAYER_SOURCES},
                **{"core/" + name: sha256(core_tree / name) for name in CORE_SOURCES},
            }
            cfg = (player_tree / "verification/source_switch/SourceSwitch.cfg").read_text()
            summary["model"] = run_tlc(
                player_tree, out, args.java, jar, "baseline", cfg, started
            )
            summary["sensitivity"] = {}
            for label, original, broken, violation in MUTATIONS:
                if cfg.count(original) != 1:
                    raise RuntimeError(label + ": sensitivity edit no longer matches")
                mutated = cfg.replace(original, broken)
                summary["sensitivity"][label] = run_tlc(
                    player_tree, out, args.java, jar, label, mutated, started, violation
                )
            summary["status"] = "PASS"
    except (
        OSError,
        RuntimeError,
        ValueError,
        subprocess.CalledProcessError,
        tarfile.TarError,
    ) as error:
        summary["error"] = str(error)
    summary.update(
        wall_seconds=round(time.monotonic() - started, 3),
        peak_child_bytes=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * 1024,
    )
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())

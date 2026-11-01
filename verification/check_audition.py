"""Check the transition-audition model (#115) against the archived player revision."""
import argparse
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import tarfile
import tempfile
import time

import check_source_switch as shared

SPEC = "verification/audition/Audition.tla"
CONFIG = "verification/audition/Audition.cfg"
PLAYER_SOURCES = (
    "src-tauri/src/lib.rs",
    "src/App.svelte",
    "src/lib/transportMode.ts",
    SPEC,
    CONFIG,
    "verification/check_audition.py",
    "verification/check_source_switch.py",
)
SERIAL = "  Serialize = TRUE\n"
RESTORE = "  RestoreOnFailure = TRUE\n"
MUTATIONS = (
    (
        "unserialized",
        ((SERIAL, "  Serialize = FALSE\n"),),
        "Invariant QuietWhilePreparing is violated",
    ),
    (
        "unserialized_banner",
        (
            (SERIAL, "  Serialize = FALSE\n"),
            ("  QuietWhilePreparing\n", ""),
            ("  QueueFollowsListener\n", ""),
        ),
        "Invariant BannerMatchesAudition is violated",
    ),
    (
        "unmute_on_failure",
        ((RESTORE, "  RestoreOnFailure = FALSE\n"),),
        "Invariant QueueFollowsListener is violated",
    ),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--jar",
        type=Path,
        default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        / "funkot-verification/tla2tools-1.7.4.jar",
        help="TLC jar prepared by check_source_switch.py --setup",
    )
    parser.add_argument("--java", default="java", help="Java 21 executable")
    parser.add_argument("--output", type=Path, help="new or empty evidence directory")
    args = parser.parse_args()

    player_root = Path(__file__).resolve().parents[1]
    out = args.output or Path(tempfile.mkdtemp(prefix="audition-proof-"))
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error("evidence directory is not empty; prior evidence is unchanged and no proof ran")
    summary = {"status": "FAIL"}
    summary_path = out / "summary.json"
    summary_path.write_text(json.dumps(summary) + "\n")
    started = time.monotonic()
    try:
        revision = shared.source_revision(player_root, "player")
        summary["revision"] = revision
        jar = args.jar.resolve(strict=True)
        if shared.sha256(jar) != shared.TLC_SHA256:
            raise RuntimeError("TLC jar does not match the fixed hash")
        java_version = subprocess.check_output(
            [args.java, "-version"], stderr=subprocess.STDOUT, text=True
        )
        if re.search(r'version "21[."]', java_version) is None:
            raise RuntimeError("Java 21 is required")
        summary["tools"] = {
            "tlc": "1.7.4",
            "jar_sha256": shared.TLC_SHA256,
            "java": java_version.splitlines()[0],
        }
        with tempfile.TemporaryDirectory(prefix="audition-player-") as temporary:
            tree = Path(temporary)
            shared.archive_commit(player_root, revision, tree, "player")
            summary["sources"] = {name: shared.sha256(tree / name) for name in PLAYER_SOURCES}
            cfg = (tree / CONFIG).read_text()
            summary["model"] = shared.run_tlc(
                tree, out, args.java, jar, "baseline", cfg, started, spec=SPEC
            )
            summary["sensitivity"] = {}
            for label, edits, violation in MUTATIONS:
                mutated = cfg
                for original, broken in edits:
                    if mutated.count(original) != 1:
                        raise RuntimeError(label + ": sensitivity edit no longer matches")
                    mutated = mutated.replace(original, broken)
                summary["sensitivity"][label] = shared.run_tlc(
                    tree, out, args.java, jar, label, mutated, started, violation, spec=SPEC
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

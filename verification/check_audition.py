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
    "src/components/PlaybackBar.svelte",
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
SOURCE_FILES = {
    "lib.rs": "src-tauri/src/lib.rs",
    "PlaybackBar.svelte": "src/components/PlaybackBar.svelte",
    "transportMode.ts": "src/lib/transportMode.ts",
}
SOURCE_REFERENCE_COUNT = 21
SOURCE_REFERENCE = re.compile(
    r"\\\*\s+(?P<source>[^\s:]+):(?P<start>\d+)(?:-(?P<end>\d+))?(?:\s+\|\s+(?P<fragment>.+))?\s*$"
)


def validate_source_references(tree, expected_count=SOURCE_REFERENCE_COUNT):
    model = tree / SPEC
    references = 0
    for line_number, line in enumerate(model.read_text().splitlines(), start=1):
        match = SOURCE_REFERENCE.search(line)
        if match is None:
            continue
        source = match["source"]
        start = int(match["start"])
        end = int(match["end"] or start)
        reference = source + ":" + match["start"]
        if match["end"] is not None:
            reference += "-" + match["end"]
        location = f"Audition.tla:{line_number} ({reference})"
        if source not in SOURCE_FILES:
            raise RuntimeError(f"source reference {location} names an unsupported source")
        fragment = match["fragment"]
        if fragment is None:
            raise RuntimeError(f"source reference {location} is missing expected fragment")
        source_lines = (tree / SOURCE_FILES[source]).read_text().splitlines()
        if start < 1 or end < start or end > len(source_lines):
            raise RuntimeError(f"source reference {location} is out of range")
        if fragment not in "\n".join(source_lines[start - 1 : end]):
            raise RuntimeError(
                f"source reference {location} does not contain expected fragment {fragment!r}"
            )
        references += 1
    if references != expected_count:
        raise RuntimeError(
            f"Audition.tla: expected {expected_count} source references but found {references}"
        )
    return references


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
        with tempfile.TemporaryDirectory(prefix="audition-player-") as temporary:
            tree = Path(temporary)
            shared.archive_commit(player_root, revision, tree, "player")
            validate_source_references(tree)
            summary["sources"] = {name: shared.sha256(tree / name) for name in PLAYER_SOURCES}
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

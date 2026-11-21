"""Check the manual-Next model (#164) against the archived player revision."""
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
from check_transport_phase import function_bodies

SPEC = "verification/manual_next/ManualNext.tla"
CONFIG = "verification/manual_next/ManualNext.cfg"
SOURCE = "src-tauri/src/lib.rs"
PLAYER_SOURCES = (SOURCE, SPEC, CONFIG, "verification/check_manual_next.py")

RULES = ("SentNextNotStuck", "PressNotLost", "OneTrackPerPress", "NoSendDuringDecode")
# Rules the code at the sync commit breaks (#166). Each must still break;
# every other rule must hold. Remove a rule here only with the fix that
# makes it hold.
FINDINGS = ("SentNextNotStuck", "OneTrackPerPress", "NoSendDuringDecode")
CODE = '  Break = "none"\n'
# Sensitivity: each deliberate break of the code must break its rule.
VARIANTS = (
    ("no_forget", "SentNextNotStuck"),
    ("no_recheck", "SentNextNotStuck"),
    ("no_waiter", "PressNotLost"),
    ("no_snapshot_check", "OneTrackPerPress"),
    ("no_busy_check", "NoSendDuringDecode"),
)

# Every write to the shared state outside #[cfg(test)] modules, by enclosing
# function. A new, moved or removed writer fails the check until the model
# accounts for it.
WRITES = (
    "MANUAL_NEXT_PENDING.store(",
    "MANUAL_NEXT_IN_FLIGHT.store(",
    "MANUAL_NEXT_EXPECTED_INDEX.store(",
    "MANUAL_NEXT_DISCARDS.fetch_add(",
    "NEXT_PREPARED.store(",
    "LIBRARY_ANALYSIS_BUSY.store(",
    "nav_tx.try_send(",
    "forget_discarded_manual_next()",
    "dispatch_manual_next(",
)
WRITERS = {
    "request_skip_next": {"MANUAL_NEXT_PENDING.store(": 4, "dispatch_manual_next(": 1},
    "press_manual_next": {
        "MANUAL_NEXT_EXPECTED_INDEX.store(": 1,
        "MANUAL_NEXT_PENDING.store(": 1,
        "dispatch_manual_next(": 1,
    },
    "forget_discarded_manual_next": {
        "NEXT_PREPARED.store(": 1,
        "MANUAL_NEXT_DISCARDS.fetch_add(": 1,
        "MANUAL_NEXT_IN_FLIGHT.store(": 1,
    },
    "commit_future_update_on": {"forget_discarded_manual_next()": 1},
    "publish_next_state": {
        "NEXT_PREPARED.store(": 1,
        "MANUAL_NEXT_PENDING.store(": 1,
        "MANUAL_NEXT_IN_FLIGHT.store(": 1,
    },
    "dispatch_manual_next": {
        "MANUAL_NEXT_PENDING.store(": 3,
        "MANUAL_NEXT_IN_FLIGHT.store(": 3,
        "nav_tx.try_send(": 1,
    },
    "revoke_reserved_on": {"forget_discarded_manual_next()": 1},
    "spawn_analysis_worker": {"LIBRARY_ANALYSIS_BUSY.store(": 3},
}
SOURCE_REFERENCE_COUNT = 42
SOURCE_REFERENCE = re.compile(
    r"\\\*\s+lib\.rs:(?P<function>[A-Za-z_][A-Za-z0-9_]*)\s+\|\s+(?P<fragment>.+?)\s*$"
)


def validate_source_references(tree, expected_count=SOURCE_REFERENCE_COUNT):
    bodies = function_bodies((tree / SOURCE).read_text())
    references = 0
    for line_number, line in enumerate((tree / SPEC).read_text().splitlines(), start=1):
        if "\\* lib.rs" not in line:
            continue
        match = SOURCE_REFERENCE.search(line)
        location = f"ManualNext.tla:{line_number}"
        if match is None:
            raise RuntimeError(f"source reference {location} must read 'lib.rs:<fn> | <fragment>'")
        function, fragment = match["function"], match["fragment"]
        if function not in bodies:
            raise RuntimeError(f"source reference {location} names fn {function}, which lib.rs no longer defines")
        if not any(fragment in body for body in bodies[function]):
            raise RuntimeError(f"source reference {location} expects fn {function} to contain {fragment!r}")
        references += 1
    if references != expected_count:
        raise RuntimeError(f"ManualNext.tla: expected {expected_count} source references but found {references}")
    return references


def validate_writers(tree, expected=WRITERS):
    bodies = function_bodies((tree / SOURCE).read_text())
    found = {}
    for name, texts in bodies.items():
        counts = {}
        for write in WRITES:
            # A function's own name in its signature is not a call.
            count = sum(body.count(write) for body in texts)
            if write == "dispatch_manual_next(" and name == "dispatch_manual_next":
                count -= len(texts)
            if write == "forget_discarded_manual_next()" and name == "forget_discarded_manual_next":
                count -= len(texts)
            if count:
                counts[write] = count
        if counts:
            found[name] = counts
    if found != expected:
        raise RuntimeError(
            f"manual Next writers changed: expected {expected}, found {found}; "
            "audit each writer against ManualNext.tla"
        )
    return found


def config_for(cfg, rules, code=CODE):
    head, separator, _ = cfg.partition("INVARIANTS\n")
    if not separator:
        raise RuntimeError("ManualNext.cfg has no INVARIANTS section")
    if head.count(CODE) != 1:
        raise RuntimeError('ManualNext.cfg must set Break = "none" once')
    return head.replace(CODE, code) + separator + "".join(f"  {rule}\n" for rule in ("TypeOK",) + tuple(rules))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--jar",
        type=Path,
        default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
        / "funkot-verification/tla2tools-1.7.4.jar",
        help="TLC jar prepared by check_source_switch.py --setup",
    )
    parser.add_argument("--java", default="java", help="Java 25 executable")
    parser.add_argument("--output", type=Path, help="new or empty evidence directory")
    args = parser.parse_args()

    player_root = Path(__file__).resolve().parents[1]
    out = args.output or Path(tempfile.mkdtemp(prefix="manual-next-proof-"))
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
        with tempfile.TemporaryDirectory(prefix="manual-next-player-") as temporary:
            tree = Path(temporary)
            shared.archive_commit(player_root, revision, tree, "player")
            validate_source_references(tree)
            summary["writers"] = validate_writers(tree)
            summary["sources"] = {name: shared.sha256(tree / name) for name in PLAYER_SOURCES}
            jar = args.jar.resolve(strict=True)
            if shared.sha256(jar) != shared.TLC_SHA256:
                raise RuntimeError("TLC jar does not match the fixed hash")
            java_version = subprocess.check_output([args.java, "-version"], stderr=subprocess.STDOUT, text=True)
            if re.search(r'version "25[."]', java_version) is None:
                raise RuntimeError("Java 25 is required")
            summary["tools"] = {"tlc": "1.7.4", "jar_sha256": shared.TLC_SHA256, "java": java_version.splitlines()[0]}
            cfg = (tree / CONFIG).read_text()
            summary["rules"] = {}
            for rule in RULES:
                violation = f"Invariant {rule} is violated" if rule in FINDINGS else None
                summary["rules"][rule] = shared.run_tlc(
                    tree, out, args.java, jar, rule, config_for(cfg, (rule,)), started, violation, spec=SPEC
                )
            summary["variants"] = {}
            for label, rule in VARIANTS:
                summary["variants"][label] = shared.run_tlc(
                    tree, out, args.java, jar, label,
                    config_for(cfg, (rule,), f'  Break = "{label}"\n'),
                    started, f"Invariant {rule} is violated", spec=SPEC,
                )
            summary["findings"] = list(FINDINGS)
            summary["status"] = "KNOWN_FINDINGS" if FINDINGS else "PASS"
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
        summary["error"] = str(error)
    summary.update(
        wall_seconds=round(time.monotonic() - started, 3),
        peak_child_bytes=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * 1024,
    )
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"] in ("PASS", "KNOWN_FINDINGS") else 1


if __name__ == "__main__":
    sys.exit(main())

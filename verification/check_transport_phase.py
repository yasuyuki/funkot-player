"""Check the transport-phase model (#161) against the archived player revision."""
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

SPEC = "verification/transport_phase/TransportPhase.tla"
CONFIG = "verification/transport_phase/TransportPhase.cfg"
SOURCE = "src-tauri/src/lib.rs"
PLAYER_SOURCES = (SOURCE, SPEC, CONFIG, "verification/check_transport_phase.py")

# Rules the code at the sync commit breaks. Each must still break; every
# other rule must hold.
FINDINGS = ()
RULES = ("FailedStaysFailed", "AliveMatchesAudioThread")
CURRENT = '  PauseWrite = "atomic"\n'
# Broken pause writes (#162). Each must still break the rules it names, so a
# pass shows the rules can fail.
VARIANTS = (
    ("before-162-failed", '  PauseWrite = "current"\n', ("FailedStaysFailed",)),
    ("before-162-alive", '  PauseWrite = "current"\n', ("AliveMatchesAudioThread",)),
    ("checked", '  PauseWrite = "checked"\n', ("FailedStaysFailed",)),
)

# Every set_phase call and other PHASE write outside #[cfg(test)] modules,
# by enclosing function. A new, moved or removed writer fails the check until
# the model accounts for it.
PHASE_WRITERS = {
    "record_pause_change": 1,
    "open_output_stream": 2,
    "audio_thread": 8,
    "start_impl": 2,
}
SOURCE_REFERENCE_COUNT = 36
SOURCE_REFERENCE = re.compile(
    r"\\\*\s+lib\.rs:(?P<function>[A-Za-z_][A-Za-z0-9_]*)\s+\|\s+(?P<fragment>.+?)\s*$"
)
PHASE_WRITE = re.compile(r"\bset_phase\(|\bPHASE\.(?:store|swap|fetch_\w+|compare_exchange\w*)\(")
FUNCTION = re.compile(r"^(?P<indent>\s*)(?:pub(?:\([^)]*\))?\s+)?(?:extern \"C\"\s+)?fn\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\b")


def test_module_lines(lines):
    """Line indexes inside top-level `#[cfg(test)] mod name {` blocks."""
    inside = set()
    index = 0
    while index < len(lines):
        if lines[index].strip() == "#[cfg(test)]" and index + 1 < len(lines) and re.match(r"^mod \w+ \{", lines[index + 1]):
            end = index + 2
            while end < len(lines) and lines[end] != "}":
                end += 1
            inside.update(range(index, end + 1))
            index = end + 1
        else:
            index += 1
    return inside


def function_bodies(text):
    """Map each non-test function name to the list of its bodies' text."""
    lines = text.splitlines()
    tests = test_module_lines(lines)
    bodies = {}
    for start, line in enumerate(lines):
        if start in tests:
            continue
        match = FUNCTION.match(line)
        if match is None or line.rstrip().endswith(";"):
            continue
        closing = match["indent"] + "}"
        end = start + 1
        while end < len(lines) and lines[end].rstrip() != closing:
            end += 1
        if end == len(lines):
            raise RuntimeError(f"lib.rs:{start + 1}: cannot find the end of fn {match['name']}")
        bodies.setdefault(match["name"], []).append("\n".join(lines[start : end + 1]))
    return bodies


def validate_source_references(tree, expected_count=SOURCE_REFERENCE_COUNT):
    bodies = function_bodies((tree / SOURCE).read_text())
    references = 0
    for line_number, line in enumerate((tree / SPEC).read_text().splitlines(), start=1):
        if "\\* lib.rs" not in line:
            continue
        match = SOURCE_REFERENCE.search(line)
        location = f"TransportPhase.tla:{line_number}"
        if match is None:
            raise RuntimeError(f"source reference {location} must read 'lib.rs:<fn> | <fragment>'")
        function, fragment = match["function"], match["fragment"]
        if function not in bodies:
            raise RuntimeError(f"source reference {location} names fn {function}, which lib.rs no longer defines")
        if not any(fragment in body for body in bodies[function]):
            raise RuntimeError(
                f"source reference {location} expects fn {function} to contain {fragment!r}"
            )
        references += 1
    if references != expected_count:
        raise RuntimeError(
            f"TransportPhase.tla: expected {expected_count} source references but found {references}"
        )
    return references


def validate_phase_writers(tree, expected=PHASE_WRITERS):
    text = (tree / SOURCE).read_text()
    bodies = function_bodies(text)
    found = {}
    for name, texts in bodies.items():
        if name == "set_phase":
            continue
        count = sum(len(PHASE_WRITE.findall(body)) for body in texts)
        if count:
            found[name] = count
    stores = sum(body.count("PHASE.store(") for body in bodies.get("set_phase", []))
    if text.count("PHASE.store(") != 1 or stores != 1:
        raise RuntimeError("PHASE must be stored only inside set_phase")
    if found != expected:
        raise RuntimeError(
            f"set_phase writers changed: expected {expected}, found {found}; "
            "audit each writer against TransportPhase.tla"
        )
    return found


def config_for(cfg, rules):
    head, separator, _ = cfg.partition("INVARIANTS\n")
    if not separator:
        raise RuntimeError("TransportPhase.cfg has no INVARIANTS section")
    return head + separator + "".join(f"  {rule}\n" for rule in ("TypeOK",) + tuple(rules))


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
    out = args.output or Path(tempfile.mkdtemp(prefix="transport-phase-proof-"))
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
        with tempfile.TemporaryDirectory(prefix="transport-phase-player-") as temporary:
            tree = Path(temporary)
            shared.archive_commit(player_root, revision, tree, "player")
            validate_source_references(tree)
            summary["phase_writers"] = validate_phase_writers(tree)
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
            if cfg.count(CURRENT) != 1:
                raise RuntimeError('TransportPhase.cfg must set PauseWrite = "atomic" once')
            summary["rules"] = {}
            for rule in RULES:
                violation = f"Invariant {rule} is violated" if rule in FINDINGS else None
                summary["rules"][rule] = shared.run_tlc(
                    tree, out, args.java, jar, rule, config_for(cfg, (rule,)), started, violation, spec=SPEC
                )
            summary["variants"] = {}
            for label, replacement, rules in VARIANTS:
                mutated = config_for(cfg, rules).replace(CURRENT, replacement)
                summary["variants"][label] = shared.run_tlc(
                    tree, out, args.java, jar, label, mutated, started,
                    f"Invariant {rules[0]} is violated", spec=SPEC,
                )
            summary["findings"] = list(FINDINGS)
            summary["status"] = "KNOWN_FINDINGS" if FINDINGS else "PASS"
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
    return 0 if summary["status"] in ("PASS", "KNOWN_FINDINGS") else 1


if __name__ == "__main__":
    sys.exit(main())

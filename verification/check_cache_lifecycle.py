"""Check native test cache ownership with the existing pinned TLC runner."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import check_source_switch as tlc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", action="store_true", help="prepare the existing fixed TLC jar")
    parser.add_argument("--jar", type=Path, default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "funkot-verification/tla2tools-1.7.4.jar")
    parser.add_argument("--java", default="java", help="Java executable")
    parser.add_argument("--output", type=Path, help="new or empty evidence directory")
    args = parser.parse_args()
    if args.setup:
        return tlc.main()
    root = Path(__file__).resolve().parents[1]
    out = args.output or Path(tempfile.mkdtemp(prefix="cache-lifecycle-proof-"))
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error("evidence directory is not empty")
    summary = {"status": "FAIL"}
    started = time.monotonic()
    try:
        revision = tlc.source_revision(root, "player")
        jar = args.jar.resolve(strict=True)
        if tlc.sha256(jar) != tlc.TLC_SHA256:
            raise RuntimeError("TLC jar does not match the fixed hash")
        summary.update(revision=revision, tlc="1.7.4", jar_sha256=tlc.TLC_SHA256)
        summary["java"] = subprocess.check_output([args.java, "-version"], stderr=subprocess.STDOUT, text=True).splitlines()[0]
        with tempfile.TemporaryDirectory(prefix="cache-lifecycle-model-") as temporary:
            tree = Path(temporary)
            tlc.archive_commit(root, revision, tree, "player")
            spec = "verification/cache_lifecycle/CacheLifecycle.tla"
            cfg = (tree / spec).with_suffix(".cfg").read_text()
            summary["source_sha256"] = {name: tlc.sha256(tree / name) for name in (
                "src-tauri/src/playlist_service/tests.rs", spec,
                "verification/cache_lifecycle/CacheLifecycle.cfg",
                "verification/check_cache_lifecycle.py", "verification/check_source_switch.py",
            )}
            results = {}
            results["ownership"] = tlc.run_tlc(tree, out, args.java, jar, "ownership", cfg, started, spec=spec)
            for name, before, after in (
                ("inherited_cwd", "IsolatedCwd = TRUE", "IsolatedCwd = FALSE"),
                ("early_cleanup", "WaitForExit = TRUE", "WaitForExit = FALSE"),
            ):
                if cfg.count(before) != 1:
                    raise RuntimeError("mutation does not match the model configuration")
                results[name] = tlc.run_tlc(tree, out, args.java, jar, name, cfg.replace(before, after), started,
                    violation="Invariant CacheOwnership is violated", spec=spec)
            summary.update(status="PASS", results=results)
    finally:
        summary["elapsed_seconds"] = time.monotonic() - started
        (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps({"status": summary["status"], "output": str(out)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

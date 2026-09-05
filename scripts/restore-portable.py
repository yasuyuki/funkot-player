#!/usr/bin/env python3
"""Restore the public source set into a new job directory, without local siblings."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lock", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    sources = (("player", "funkot-player", "https://github.com/yasuyuki/funkot-player.git"),
               ("engine", "funkot-autodj-for-ui", "https://github.com/yasuyuki/funkot-autodj.git"))
    for key, _, _ in sources:
        if not re.fullmatch(r"[0-9a-f]{40}", lock["source_set"][key]):
            raise SystemExit(f"invalid immutable SHA: {key}")
    args.destination.mkdir(parents=True, exist_ok=False)
    for key, directory, remote in sources:
        path = args.destination / directory
        subprocess.run(["git", "clone", "--no-checkout", remote, str(path)], check=True)
        sha = lock["source_set"][key]
        subprocess.run(["git", "-C", str(path), "checkout", "-b", "pilot/portable", sha], check=True)
        actual = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
        if actual != sha:
            raise SystemExit(f"checkout mismatch: {key}")
    manifest = {"schema": 1, "id": "funkot-dev", "members": [
        {"name": directory, "path": directory, "remote": remote, "branch": "pilot/portable"}
        for _, directory, remote in sources
    ]}
    (args.destination / "WORKING-SET.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Restored locked sources. No credential isolation or verification is implied.")


if __name__ == "__main__":
    main()

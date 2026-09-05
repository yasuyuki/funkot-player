#!/usr/bin/env python3
"""Run the existing unsigned checks and record exact inputs and exit codes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lock", type=Path)
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--record-inputs", action="store_true", help="record this clean source/toolchain/package set before verification")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    engine = root.parent / "funkot-autodj-for-ui"
    versions = {name: output(name, "--version") for name in ("node", "npm", "rustc", "cargo")}
    binaries = {name: hashlib.sha256(Path(shutil.which(name)).resolve().read_bytes()).hexdigest()
                for name in versions}
    build_keys = ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
                  "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "LIBCLANG_PATH",
                  "BINDGEN_EXTRA_CLANG_ARGS", "PKG_CONFIG_PATH", "NODE_OPTIONS")
    # Store hashes, never credential/config values or private paths.
    build_environment = {key: hashlib.sha256(os.environ[key].encode()).hexdigest()
                         for key in build_keys if key in os.environ}
    system = output("dpkg-query", "-W", "-f=${Package}=${Version}\\n")
    if args.record_inputs:
        lock = {
            "source_set": {name: output("git", "-C", str(repo), "rev-parse", "HEAD")
                           for name, repo in (("player", root), ("engine", engine))},
            "toolchain": versions,
            "tool_binaries_sha256": binaries,
            "build_environment": build_environment,
            "system_packages_sha256": hashlib.sha256(system.encode()).hexdigest(),
            "system_packages": system.splitlines(),
            "fixture": "Test fixtures tracked by source_set; no external data",
        }
        with args.lock.open("x") as stream:
            json.dump(lock, stream, indent=2)
    lock_bytes = args.lock.read_bytes()
    lock = json.loads(lock_bytes)
    for name, repo in (("player", root), ("engine", engine)):
        if output("git", "-C", str(repo), "rev-parse", "HEAD") != lock["source_set"][name]:
            raise SystemExit(f"{name} SHA differs from lock")
        if output("git", "-C", str(repo), "status", "--porcelain", "--untracked-files=normal"):
            raise SystemExit(f"{name} has uncommitted input")
    if versions != lock["toolchain"]:
        raise SystemExit("toolchain differs from lock")
    if binaries != lock["tool_binaries_sha256"] or build_environment != lock["build_environment"]:
        raise SystemExit("tool bytes or build environment differ from lock")
    if hashlib.sha256(system.encode()).hexdigest() != lock["system_packages_sha256"]:
        raise SystemExit("host package set differs from lock; rebuild the declared environment")
    commands = [
        ["npm", "ci"],
        ["npm", "test"],
        ["npm", "run", "check"],
        ["npm", "run", "build"],
        ["cargo", "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib"],
        ["sh", "scripts/check-release-invariants.sh"],
        ["sh", "scripts/set-version.sh", "--check"],
        ["sh", "scripts/check-msix-languages.sh"],
        ["sh", "scripts/check-doc-claims.sh"],
    ]
    receipt = {"source_set": lock["source_set"], "toolchain": versions,
               "lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
               "definition_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "started": time.time(), "result": "running", "checks": []}
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    if args.receipt.exists():
        raise SystemExit("receipt already exists; choose a new attempt receipt")
    with args.receipt.open("x") as stream:
        json.dump(receipt, stream, indent=2)
    logs = args.receipt.with_suffix(".logs")
    logs.mkdir(exist_ok=False)
    for index, command in enumerate(commands):
        start = time.time()
        log = logs / f"{index}.log"
        print("Running:", " ".join(command), flush=True)
        with log.open("xb") as stream:
            result = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
        receipt["checks"].append({"argv": command, "exit": result.returncode,
                                  "seconds": time.time() - start,
                                  "log": str(log), "log_sha256": hashlib.sha256(log.read_bytes()).hexdigest()})
        if result.returncode:
            receipt["result"] = "fail"
            print(log.read_text(errors="replace"))
            break
    else:
        receipt["result"] = "pass"
        for name, repo in (("player", root), ("engine", engine)):
            if (output("git", "-C", str(repo), "rev-parse", "HEAD") != lock["source_set"][name]
                    or output("git", "-C", str(repo), "status", "--porcelain", "--untracked-files=normal")):
                receipt["result"] = "fail"
                receipt["input_changed"] = name
    receipt["finished"] = time.time()
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    return 0 if receipt["result"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

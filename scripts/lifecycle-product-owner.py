#!/usr/bin/env python3
"""Own the managed, task-scoped Cargo output created by ``dev.sh``.

This program deliberately owns only a generation root and one Docker volume.
The lifecycle service owns the receipt registry and calls ``reclaim`` only after
its task lease and user-release checks have succeeded.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import copy
import fcntl
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

OWNER = "funkot-player-build"
SCHEMA = 1


class OwnerError(RuntimeError):
    pass


def die(message: str) -> None:
    raise OwnerError(message)


def compact(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        die(f"invalid managed owner record {path}: {exc}")
    if not isinstance(value, dict):
        die(f"invalid managed owner record {path}: expected object")
    return value


def checked_context(raw: str) -> dict:
    try:
        value = json.loads(raw)
    except ValueError as exc:
        die(f"invalid WORKSPACE_LIFECYCLE_CONTEXT: {exc}")
    required = {"version", "owner_receipt_argv", "owner_receipt_dir", "repo", "task"}
    if not isinstance(value, dict) or not required.issubset(value) or value.get("version") != 1:
        die("WORKSPACE_LIFECYCLE_CONTEXT must be version 1 with owner receipt fields")
    if (not isinstance(value["owner_receipt_argv"], list)
            or not value["owner_receipt_argv"]
            or not all(isinstance(item, str) and item for item in value["owner_receipt_argv"])):
        die("WORKSPACE_LIFECYCLE_CONTEXT owner_receipt_argv must be a nonempty argv")
    for key in ("owner_receipt_dir", "repo", "task"):
        if not isinstance(value[key], str) or not value[key]:
            die(f"WORKSPACE_LIFECYCLE_CONTEXT {key} must be nonempty")
    if not Path(value["owner_receipt_dir"]).is_absolute() or not Path(value["repo"]).is_absolute() or not Path(value["owner_receipt_argv"][0]).is_absolute():
        die("WORKSPACE_LIFECYCLE_CONTEXT paths must be absolute")
    return value


def context_from_env() -> dict:
    raw = os.environ.get("WORKSPACE_LIFECYCLE_CONTEXT")
    if not raw:
        die("managed owner requires WORKSPACE_LIFECYCLE_CONTEXT")
    return checked_context(raw)


def docker(*argv: str, input: str | None = None) -> str:
    command = [os.environ.get("DOCKER", "docker"), *argv]
    result = subprocess.run(command, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        die("docker command failed: " + " ".join(command) + "\n" + result.stderr.strip())
    return result.stdout


def volume_exists(name: str) -> bool:
    rows = docker("volume", "ls", "-q", "--filter", "name=^" + name + "$").splitlines()
    if rows not in ([], [name]):
        die("docker volume ls did not uniquely classify " + name)
    return bool(rows)


def daemon_identity() -> tuple[str, str]:
    daemon = docker("info", "--format", "{{.ID}}").strip()
    endpoint = docker("context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}').strip()
    if not daemon or not endpoint:
        die("docker daemon identity or endpoint is empty")
    return daemon, endpoint

def source_revision(repo: Path) -> str:
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode or not result.stdout.strip():
        die("cannot record product source revision")
    return result.stdout.strip()


def generation_name(task: str, generation: str) -> str:
    return "funkot-player-task-" + sha256(task + "\0" + generation)[:32]


def labels(task: str, generation: str, daemon: str, endpoint: str) -> dict[str, str]:
    return {
        "jp.hatsuboshi.workspace-lifecycle.schema": "1",
        "jp.hatsuboshi.workspace-lifecycle.owner": OWNER,
        "jp.hatsuboshi.workspace-lifecycle.task-sha256": sha256(task),
        "jp.hatsuboshi.workspace-lifecycle.generation": generation,
        "jp.hatsuboshi.workspace-lifecycle.daemon-id": daemon,
        "jp.hatsuboshi.workspace-lifecycle.endpoint-sha256": sha256(endpoint),
    }


def inspect_volume(name: str) -> dict | None:
    if not volume_exists(name):
        return None
    text = docker("volume", "inspect", name)
    try:
        data = json.loads(text)
    except ValueError as exc:
        die(f"docker volume inspect returned invalid JSON: {exc}")
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        die("docker volume inspect returned no unique volume")
    return data[0]


def exact_volume_identity(record: dict, inspected: dict, daemon: str, endpoint: str) -> None:
    expected = record.get("volume")
    if not isinstance(expected, dict):
        die("owner receipt has no volume identity")
    actual_labels = inspected.get("Labels") or {}
    actual = {
        "name": inspected.get("Name"),
        "created_at": inspected.get("CreatedAt"),
        "labels": dict(sorted(actual_labels.items())),
        "daemon_id": daemon,
        "endpoint": endpoint,
    }
    if actual != expected:
        die("managed Cargo volume identity changed; refusing to claim or remove it")


def record_paths(context: dict, generation: str) -> tuple[Path, Path, Path]:
    directory = Path(context["owner_receipt_dir"])
    stem = OWNER + "-" + generation
    return directory / (stem + ".intent.json"), directory / (stem + ".json"), directory / "generations" / generation


@contextmanager
def owner_lock(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    if os.environ.get("FUNKOT_PLAYER_OWNER_OUTER_LEASE") == "1":
        yield
        return
    with (directory / ".funkot-player-build.lock").open("a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(stream, fcntl.LOCK_UN)


def output_mounts(repo: Path, root: Path) -> dict[str, str]:
    worktree = {"dist": repo / "dist",
                "android_build": repo / "src-tauri/gen/android/app/build",
                "android_gradle": repo / "src-tauri/gen/android/.gradle",
                "android_jni": repo / "src-tauri/gen/android/app/src/main/jniLibs"}
    for path in worktree.values():
        if path.exists() or path.is_symlink():
            die("managed output path already exists: " + str(path))
    return {key: str(root / key) for key in worktree}


def active_intent(context: dict) -> tuple[Path, dict] | None:
    directory = Path(context["owner_receipt_dir"])
    if not directory.exists():
        return None
    matches: list[tuple[Path, dict]] = []
    for path in sorted(directory.glob(OWNER + "-*.intent.json")):
        record = read_json(path)
        if record.get("task") == context["task"] and record.get("repo") == context["repo"] and record.get("state") != "reclaimed":
            matches.append((path, record))
    if len(matches) > 1:
        die("more than one active managed player generation exists for this task")
    return matches[0] if matches else None


def lifecycle_register(context: dict, record: dict) -> None:
    root = Path(record["output"])
    if root.exists() or root.is_symlink():
        die("managed generation root appeared before lifecycle registration")
    completion = [context["owner_receipt_argv"][0], str(Path(__file__).resolve()), "reclaim",
                  "--receipt", record["receipt"], "--generation", record["generation"],
                  "--result-ref", "{result_ref}"]
    command = [*context["owner_receipt_argv"], "--owner", OWNER,
               "--generation", record["generation"], "--receipt", record["receipt"],
               "--output", record["output"], "--completion-json", compact(completion)]
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        die("lifecycle owner receipt registration failed: " + result.stderr.strip())


def prepare(context: dict) -> dict:
    # Refuse before registration, root creation, or Docker volume creation when
    # the advertised public reclamation API is not installed.
    reclamation_api()
    repo = Path(context["repo"])
    current = active_intent(context)
    if current:
        intent_path, record = current
        generation = record.get("generation")
        if not isinstance(generation, str) or not generation:
            die("active managed owner record lacks generation")
    else:
        generation = uuid.uuid4().hex
        intent_path, receipt, root = record_paths(context, generation)
        daemon, endpoint = daemon_identity()
        volume_name = generation_name(context["task"], generation)
        record = {
            "schema": SCHEMA, "owner": OWNER, "state": "intent",
            "repo": str(repo), "task": context["task"], "generation": generation,
            "receipt": str(receipt), "output": str(root), "source_revision": source_revision(repo),
            "inputs": [], "identity": {"root": None, "volume_name": volume_name,
                                           "daemon_id": daemon, "endpoint": endpoint},
            "mounts": output_mounts(repo, root),
        }
        # Durable product creation intent is deliberately before lifecycle register.
        atomic_json(intent_path, record)
    receipt = Path(record["receipt"])
    root = Path(record["output"])
    output_mounts(repo, root)
    requested_target = os.environ.get("FUNKOT_CARGO_TARGET", "funkot-player-cargo-target")
    if record.get("cargo_target") and requested_target != record["cargo_target"]:
        die("managed Cargo target choice changed")
    if record.get("state") == "intent":
        lifecycle_register(context, record)
        record["state"] = "registered"
        atomic_json(intent_path, record)
    if record.get("state") not in {"registered", "active", "sealed"}:
        die("managed owner receipt is not resumable")
    daemon, endpoint = daemon_identity()
    volume_name = os.environ.get("FUNKOT_CARGO_TARGET", "funkot-player-cargo-target")
    custom_volume = "FUNKOT_CARGO_TARGET" in os.environ and volume_name != "funkot-player-cargo-target"
    record["cargo_target"] = volume_name
    if custom_volume:
        inspected = inspect_volume(volume_name)
        if inspected is None:
            record["cargo_create_expected"] = {"name": volume_name, "labels": labels(context["task"], generation, daemon, endpoint), "daemon_id": daemon, "endpoint": endpoint}
            atomic_json(intent_path, record)
            if record.get("volume") is not None:
                die("recorded managed Cargo volume disappeared")
            expected_labels = labels(context["task"], generation, daemon, endpoint)
            args = ["volume", "create", "--name", volume_name]
            for key, value in sorted(expected_labels.items()): args.extend(["--label", key + "=" + value])
            docker(*args)
            inspected = inspect_volume(volume_name)
            if inspected is None: die("created managed Cargo volume cannot be inspected")
            actual_labels = dict(sorted((inspected.get("Labels") or {}).items()))
            if actual_labels != expected_labels or inspected.get("Name") != volume_name or not inspected.get("CreatedAt"): die("created managed Cargo volume does not have its exact identity")
            record["volume"] = {"name": volume_name, "created_at": inspected["CreatedAt"], "labels": actual_labels, "daemon_id": daemon, "endpoint": endpoint}
        elif record.get("volume") is None:
            expected = record.get("cargo_create_expected")
            actual = {"name": inspected.get("Name"), "labels": dict(sorted((inspected.get("Labels") or {}).items())), "daemon_id": daemon, "endpoint": endpoint}
            if not isinstance(expected, dict) or actual != expected:
                die("refusing to claim a preexisting custom Cargo volume")
            record["volume"] = {**actual, "created_at": inspected.get("CreatedAt")}
        else:
            exact_volume_identity(record, inspected, daemon, endpoint)
    else:
        record["volume"] = None
    atomic_json(intent_path, record)
    node_name = "funkot-player-node-" + sha256(context["task"] + "\0" + generation)[:32]
    node = inspect_volume(node_name)
    if node is None:
        if record.get("node_volume") is not None:
            die("recorded managed node volume disappeared")
        expected = labels(context["task"], generation, daemon, endpoint)
        record["node_create_expected"] = {"name": node_name, "labels": expected, "daemon_id": daemon, "endpoint": endpoint}
        atomic_json(intent_path, record)
        args = ["volume", "create", "--name", node_name]
        for key, value in sorted(expected.items()): args.extend(["--label", key + "=" + value])
        docker(*args); node = inspect_volume(node_name)
        if node is None: die("created managed node volume cannot be inspected")
        actual = dict(sorted((node.get("Labels") or {}).items()))
        if actual != expected or not node.get("CreatedAt"): die("created managed node volume does not have its exact identity")
        record["node_volume"] = {"name": node_name, "created_at": node["CreatedAt"], "labels": actual, "daemon_id": daemon, "endpoint": endpoint}
    elif record.get("node_volume") is None:
        pending = record.get("node_create_expected")
        actual = {"name": node.get("Name"), "labels": dict(sorted((node.get("Labels") or {}).items())), "daemon_id": daemon, "endpoint": endpoint}
        if not isinstance(pending, dict) or actual != pending:
            die("refusing to claim a preexisting custom node volume")
        record["node_volume"] = {**actual, "created_at": node.get("CreatedAt")}
    else:
        exact_volume_identity({"volume": record["node_volume"]}, node, daemon, endpoint)
    atomic_json(intent_path, record)
    if root.is_symlink():
        die("managed generation root became a link")
    if not root.exists():
        root.mkdir(parents=True)
        for path in record["mounts"].values():
            Path(path).mkdir(parents=True)
        root_info = root.stat()
        record["identity"]["root"] = [root_info.st_dev, root_info.st_ino]
        atomic_json(intent_path, record)
    else:
        root_info = root.stat()
        if record["identity"].get("root") != [root_info.st_dev, root_info.st_ino]:
            die("managed generation root identity changed")
    if record.get("state") == "sealed":
        for key in ("host_manifest", "host_capture", "volume_proof", "node_volume_proof", "sha256", "image"):
            record.pop(key, None)
    record["state"] = "active"
    atomic_json(intent_path, record)
    return record


def stable_volume_digest(volume: dict, image: str) -> tuple[list[str], str]:
    script = 'set -euo pipefail; cd /cargo-target; test -z "$(find . -xdev ! -type d ! -type f ! -type l -print -quit)"; test -z "$(find . -xdev -name .git -print -quit)"; tar --sort=name --numeric-owner --mtime=@0 --owner=0 --group=0 -cf - . | sha256sum'
    output = docker("run", "--rm", "-v", volume["name"] + ":/cargo-target:ro", image, "bash", "-c", script)
    fields = output.split()
    if len(fields) < 1 or len(fields[0]) != 64: die("managed volume proof is invalid")
    return ["canonical-tar-sha256-v2"], fields[0]

def file_sha256(path: Path, before: os.stat_result) -> str:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink) != (before.st_dev, before.st_ino, before.st_mode, before.st_nlink):
                die("generation output identity changed while sealing")
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            return digest.hexdigest()
    finally:
        # fdopen closes the descriptor on normal paths; close is harmless only
        # when opening itself failed, which is handled before entering try.
        pass


def host_manifest(root: Path, root_identity: list[int]) -> list[list[str]]:
    try:
        root_info = root.lstat()
    except OSError as exc:
        die("cannot inspect managed generation root: " + str(exc))
    if (root_info.st_dev, root_info.st_ino) != tuple(root_identity) or not stat.S_ISDIR(root_info.st_mode):
        die("managed generation root identity changed")
    rows: list[list[str]] = []
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in list(dirs):
            path = current_path / name
            info = path.lstat()
            relative = path.relative_to(root).as_posix()
            if name == ".git" or stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_dev != root_info.st_dev:
                die("managed generation root contains an unsafe directory: " + relative)
            rows.append([relative, "dir", ""])
        for name in files:
            path = current_path / name
            info = path.lstat()
            relative = path.relative_to(root).as_posix()
            if name == ".git" or stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_dev != root_info.st_dev:
                die("managed generation root contains an unsafe file: " + relative)
            rows.append([relative, "file", file_sha256(path, info)])
    rows.sort(key=lambda row: row[0])
    return rows


def reclamation_api():
    try:
        from workspace_lifecycle import reclamation
    except ImportError as exc:
        die("managed reclamation requires workspace_lifecycle 0.4 reclamation API: " + str(exc))
    for name in ("capture", "remove_tree"):
        if not callable(getattr(reclamation, name, None)):
            die("managed reclamation requires workspace_lifecycle.reclamation." + name)
    return reclamation


def seal(context: dict, generation: str, image: str, argv: list[str]) -> None:
    intent_path, _receipt, _root = record_paths(context, generation)
    record = read_json(intent_path)
    if record.get("state") == "sealed":
        return
    if record.get("state") != "active":
        die("cannot seal a generation that is not active")
    root = Path(record["output"])
    root_identity = record.get("identity", {}).get("root")
    if not isinstance(root_identity, list) or len(root_identity) != 2:
        die("managed generation root has no identity")
    record["source_revision"] = source_revision(Path(context["repo"]))
    inputs = ["argv=" + compact(argv)]
    core = Path(context["repo"]).parent / "funkot-autodj-for-ui"
    if (core / ".git").exists():
        inputs.append("core_revision=" + source_revision(core))
    if argv[:4] == ["npx", "tauri", "android", "build"] and "--debug" in argv:
        candidates = sorted(Path(record["mounts"]["android_build"]).glob("outputs/apk/**/debug/*.apk"))
        if len(candidates) != 1:
            die("debug build requires exactly one generated debug APK")
        inputs.append("debug_apk=" + str(candidates[0]))
    record["inputs"] = inputs
    reclamation = reclamation_api()
    manifest = host_manifest(root, root_identity)
    capture = reclamation.capture(root, manifest, root_identity)
    members, digest = stable_volume_digest(record["volume"], image) if record["volume"] else (["retained-shared-cargo-target"], "")
    record["host_manifest"] = manifest
    record["host_capture"] = capture
    record["image"] = image
    record["volume_proof"] = {"members": members, "sha256": digest}
    node_members, node_digest = stable_volume_digest(record["node_volume"], image)
    record["node_volume_proof"] = {"members": node_members, "sha256": node_digest}
    record["sha256"] = sha256(compact({"manifest": manifest, "capture": capture, "volume": record["volume_proof"], "node_volume": record["node_volume_proof"]}))
    record["state"] = "sealed"
    atomic_json(intent_path, record)


def persist_completion(receipt: Path, record: dict, result_ref: str, state: str) -> dict:
    receipt_record = read_json(receipt) if receipt.exists() else {}
    receipt_record.update({
        "generation": record["generation"], "owner": OWNER, "output": record["output"],
        "receipt": str(receipt), "state": state, "hold": False,
        "source_revision": record["source_revision"], "inputs": record.get("inputs", []),
        "identity": {"root": record["identity"]["root"], "volume": record["volume"], "node_volume": record["node_volume"]},
        "sha256": record["sha256"], "completion_result_ref": result_ref,
        "host_manifest": record["host_manifest"],
        "host_capture": record["host_capture"], "volume_proof": record["volume_proof"], "node_volume_proof": record["node_volume_proof"],
        "accepted_proof": result_ref, "released_proof": result_ref,
    })
    atomic_json(receipt, receipt_record)
    return receipt_record


def volume_has_containers(name: str) -> bool:
    # Docker lists every container, running or stopped, that references volume.
    return bool(docker("ps", "-a", "--filter", "volume=" + name, "--format", "{{.ID}}").strip())


def reclaim(receipt: Path, generation: str, result_ref: str) -> None:
    intent_path = receipt.with_name(OWNER + "-" + generation + ".intent.json")
    intent = read_json(intent_path)
    if intent.get("generation") != generation or intent.get("owner") != OWNER:
        die("intent generation or owner mismatch")
    if intent.get("state") != "sealed":
        die("managed generation is not sealed; refusing acceptance cleanup")
    root = Path(intent.get("output", ""))
    if not root.is_absolute() or intent.get("receipt") != str(receipt):
        die("intent does not match callback receipt")
    record = read_json(receipt) if receipt.exists() else {}
    if record and (record.get("generation") != generation or record.get("owner") != OWNER
                   or record.get("output") != str(root)):
        die("receipt generation or owner mismatch")
    # Journal the exact callback and deletion intent before either deletion.
    if record.get("hold") is True:
        die("receipt is held")
    if record.get("completion_result_ref") not in (None, result_ref):
        die("callback result reference changed")
    if record.get("state") == "reclaimed":
        print(compact({"reclaimed": True, "generation": generation, "receipt": str(receipt)}))
        return
    record = persist_completion(receipt, intent, result_ref, "reclaim-pending")
    if not record.get("host_delete_intended"):
        if not root.exists():
            die("managed generation root is missing without a prior deletion intent")
        record["host_delete_intended"] = True
        atomic_json(receipt, record)
    volume = record["identity"]["volume"]
    daemon, endpoint = daemon_identity()
    inspected = inspect_volume(volume["name"]) if volume else None
    if volume is None:
        pass
    elif inspected is None:
        if not record.get("volume_delete_intended"):
            die("managed Cargo volume disappeared before deletion intent")
    else:
        exact_volume_identity({"volume": volume}, inspected, daemon, endpoint)
        if volume_has_containers(volume["name"]):
            die("refusing to remove managed Cargo volume referenced by a container")
        record["volume_delete_intended"] = True
        atomic_json(receipt, record)
    reclamation = reclamation_api()
    if volume is not None and inspected is not None:
        members, digest = stable_volume_digest(volume, intent["image"])
        if {"members": members, "sha256": digest} != record["volume_proof"]:
            die("managed Cargo volume content changed after sealing")
    if not record.get("host_delete_intended"):
        die("managed generation root is missing without a prior deletion intent")
    if "host_delete_progress" not in record:
        record["host_delete_progress"] = copy.deepcopy(record["host_capture"])
        atomic_json(receipt, record)
    progress = record["host_delete_progress"]
    def persist() -> None:
        atomic_json(receipt, record)
    reclamation.remove_tree(root, record["host_manifest"], record["identity"]["root"], progress, persist)
    record["host_delete_intended"] = True
    atomic_json(receipt, record)
    inspected = inspect_volume(volume["name"]) if volume else None
    if volume is None:
        pass
    elif inspected is not None:
        exact_volume_identity({"volume": volume}, inspected, daemon, endpoint)
        if volume_has_containers(volume["name"]):
            die("refusing to remove managed Cargo volume referenced by a container")
        docker("volume", "rm", volume["name"])
        if inspect_volume(volume["name"]) is not None:
            die("managed Cargo volume still exists after rm")
    elif not record.get("volume_delete_intended"):
        die("managed Cargo volume disappeared before deletion intent")
    node = record["identity"]["node_volume"]
    checked = inspect_volume(node["name"])
    if checked is None:
        if not record.get("node_volume_delete_intended"):
            die("managed node volume disappeared before deletion intent")
    else:
        exact_volume_identity({"volume": node}, checked, daemon, endpoint)
        if volume_has_containers(node["name"]):
            die("refusing to remove managed node volume referenced by a container")
        node_members, node_digest = stable_volume_digest(node, intent["image"])
        if {"members": node_members, "sha256": node_digest} != record["node_volume_proof"]:
            die("managed node volume content changed after sealing")
        record["node_volume_delete_intended"] = True
        atomic_json(receipt, record)
        docker("volume", "rm", node["name"])
        if inspect_volume(node["name"]) is not None:
            die("managed node volume still exists after rm")
    record = persist_completion(receipt, intent, result_ref, "reclaimed")
    print(compact({"reclaimed": True, "generation": generation, "receipt": str(receipt)}))


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare")
    seal_parser = commands.add_parser("seal")
    seal_parser.add_argument("--generation", required=True)
    seal_parser.add_argument("--image", required=True)
    seal_parser.add_argument("argv", nargs=argparse.REMAINDER)
    reclaim_parser = commands.add_parser("reclaim")
    reclaim_parser.add_argument("--receipt", required=True)
    reclaim_parser.add_argument("--generation", required=True)
    reclaim_parser.add_argument("--result-ref", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            context = context_from_env()
            with owner_lock(Path(context["owner_receipt_dir"])):
                print(compact(prepare(context)))
        elif args.command == "seal":
            context = context_from_env()
            with owner_lock(Path(context["owner_receipt_dir"])):
                seal(context, args.generation, args.image, args.argv[1:] if args.argv[:1] == ["--"] else args.argv)
        else:
            receipt = Path(args.receipt)
            with owner_lock(receipt.parent):
                reclaim(receipt, args.generation, args.result_ref)
        return 0
    except OwnerError as exc:
        print("funkot-player managed owner: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

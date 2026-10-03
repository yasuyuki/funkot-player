#!/usr/bin/env python3
"""Own one Windows-native Tauri build generation for funkot-player.

The PowerShell caller owns the operation lock while it builds, seals, verifies,
and deploys.  ``complete`` and ``resume`` take that same lock themselves when
they run as lifecycle callbacks.  This module owns only generation roots under
``src-tauri/target/native-generations``.  It never removes the shared native
target directory or an externally configured build directory.
"""
from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import uuid


OWNER = "funkot-player-windows-build"
SCHEMA = 1
STATES = {"active", "sealed", "failed", "cleanup_pending", "reclaimed"}


class OwnerError(RuntimeError):
    pass


def _checkpoint(_event: str, _path: str) -> None:
    """Private test hook for crashes between durable generation steps."""


def die(message: str) -> None:
    raise OwnerError(message)


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def no_links(path: Path | str) -> None:
    """Reject links before a receipt, lock, or generated root can be adopted."""
    raw = Path(path)
    for component in (raw, *raw.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or (getattr(info, "st_file_attributes", 0)
                                          & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            die("Windows build owner path cannot traverse a link or reparse point: " + str(component))


def canonical(path: Path | str) -> Path:
    raw = Path(path)
    no_links(raw)
    return raw.resolve(strict=False)


def normalized_absolute(path: Path | str) -> str:
    raw = Path(path)
    if not raw.is_absolute():
        die("Windows build owner path must be absolute")
    return os.path.normcase(os.path.normpath(os.path.abspath(str(raw))))


def atomic_json(path: Path, value: dict) -> None:
    no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    no_links(path.parent)
    temporary = path.with_name("." + path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(compact(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        die("invalid Windows build owner record " + str(path) + ": " + str(exc))
    if not isinstance(value, dict):
        die("Windows build owner record must be an object: " + str(path))
    return value


def source_revision(repo: Path) -> str:
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode or len(result.stdout.strip()) != 40:
        die("cannot record Windows build source revision")
    return result.stdout.strip()


def git_common_dir(repo: Path) -> Path:
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", "--path-format=absolute",
                             "--git-common-dir"], text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if result.returncode or not result.stdout.strip():
        die("cannot resolve the Git common directory")
    return canonical(result.stdout.strip())


def reclamation_api():
    try:
        from workspace_lifecycle import reclamation
    except ImportError as exc:
        die("Windows build ownership requires workspace_lifecycle.reclamation: " + str(exc))
    for name in ("capture", "remove_tree"):
        if not callable(getattr(reclamation, name, None)):
            die("Windows build ownership requires workspace_lifecycle.reclamation." + name)
    return reclamation


def input_snapshot(path: Path | str) -> dict:
    value = read_json(Path(path))
    build_directory = value.get("build_directory")
    if not isinstance(build_directory, str) or not Path(build_directory).is_absolute():
        die("inputs.build_directory must be an absolute path")
    return value


def validate_inputs(repo: Path, inputs: dict) -> None:
    build_directory = canonical(inputs["build_directory"])
    target = canonical(repo / "src-tauri" / "target")
    dedicated = target / "native-generations"
    if build_directory == target or build_directory == dedicated or dedicated in build_directory.parents:
        die("inputs.build_directory must not use the dedicated native target root")


def identity(path: Path) -> list[int]:
    info = path.stat(follow_symlinks=False)
    return [info.st_dev, info.st_ino]


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_manifest(root: Path, root_identity: list[int]) -> list[list[str]]:
    if not root.is_dir() or root.is_symlink() or identity(root) != root_identity:
        die("generation root identity changed")
    rows: list[list[str]] = []
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in directories:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if (name == ".git" or not path.is_dir() or path.is_symlink()
                    or info.st_dev != root.stat(follow_symlinks=False).st_dev):
                die("generation contains an unsafe directory: " + relative)
            rows.append([relative, "dir", ""])
        for name in files:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if (name == ".git" or not path.is_file() or path.is_symlink()
                    or info.st_dev != root.stat(follow_symlinks=False).st_dev or info.st_nlink != 1):
                die("generation contains an unsafe file: " + relative)
            rows.append([relative, "file", file_hash(path)])
    rows.sort(key=lambda row: row[0])
    return rows


def reject_intermediates(manifest: list[list[str]]) -> None:
    protected = {"deps", "build", "incremental", ".fingerprint"}
    for logical, _kind, _digest in manifest:
        if protected.intersection(PurePosixPath(logical).parts):
            die("generation contains Cargo intermediate output: " + logical)


def deploy_files(root: Path) -> dict[str, str]:
    release = root / "release"
    executable = release / "funkot-player.exe"
    if not executable.is_file() or executable.is_symlink():
        die("sealed Windows build requires release/funkot-player.exe")
    files = {"release/funkot-player.exe": file_hash(executable)}
    for library in sorted(release.glob("*.dll")):
        if not library.is_file() or library.is_symlink():
            die("Windows release DLL is not a regular file: " + str(library))
        files[library.relative_to(root).as_posix()] = file_hash(library)
    return files


def dist_files(repo: Path) -> list[list[str]]:
    """Hash generated frontend files without treating them as reclaimable output."""
    root = repo / "dist"
    if not root.is_dir() or root.is_symlink():
        die("sealed Windows build requires generated dist directory")
    rows: list[list[str]] = []
    root_device = root.stat(follow_symlinks=False).st_dev
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in directories:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if not path.is_dir() or path.is_symlink() or path.lstat().st_dev != root_device:
                die("generated dist contains an unsafe directory: " + relative)
            rows.append([relative, "dir", ""])
        for name in files:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if (not path.is_file() or path.is_symlink() or info.st_dev != root_device
                    or info.st_nlink != 1):
                die("generated dist contains an unsafe file: " + relative)
            rows.append([relative, "file", file_hash(path)])
    rows.sort(key=lambda row: row[0])
    return rows


def context_from_env(repo: Path) -> dict | None:
    raw = os.environ.get("WORKSPACE_LIFECYCLE_CONTEXT")
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except ValueError as exc:
        die("invalid WORKSPACE_LIFECYCLE_CONTEXT: " + str(exc))
    required = {"version", "repo", "task", "owner_receipt_dir", "owner_receipt_argv"}
    if not isinstance(value, dict) or value.get("version") != 1 or not required.issubset(value):
        die("WORKSPACE_LIFECYCLE_CONTEXT must contain version 1 owner receipt fields")
    if canonical(value["repo"]) != repo:
        die("WORKSPACE_LIFECYCLE_CONTEXT repo does not match --repo")
    if (not isinstance(value["task"], str) or not value["task"]
            or not isinstance(value["owner_receipt_dir"], str)
            or not Path(value["owner_receipt_dir"]).is_absolute()
            or not isinstance(value["owner_receipt_argv"], list)
            or not value["owner_receipt_argv"]
            or not all(isinstance(item, str) and item for item in value["owner_receipt_argv"])):
        die("WORKSPACE_LIFECYCLE_CONTEXT owner receipt fields are invalid")
    return value


def receipt_directory(repo: Path, context: dict | None) -> Path:
    if context is not None:
        return canonical(context["owner_receipt_dir"])
    return git_common_dir(repo) / "native-windows-receipts"


def registered_receipt_directory(repo: Path, record: dict, context: dict | None) -> Path:
    task = record.get("task")
    if task is None:
        return receipt_directory(repo, None)
    if not isinstance(task, str) or not task:
        die("managed Windows build receipt has an invalid task")
    try:
        from workspace_lifecycle.producers import task_receipt_dir
    except ImportError as exc:
        die("managed receipt validation requires workspace_lifecycle.producers: " + str(exc))
    expected = canonical(task_receipt_dir(repo, task))
    if context is not None:
        if context.get("task") != task or receipt_directory(repo, context) != expected:
            die("managed receipt context does not match the registered task directory")
    return expected


def receipt_key(repo: Path, context: dict | None) -> str:
    task = context["task"] if context is not None else "unmanaged"
    return sha256(str(canonical(repo)) + "\0" + task)


def latest_path(directory: Path, key: str) -> Path:
    return directory / ("latest-" + key + ".json")


def operation_lock_path(repo: Path, _context: dict | None = None) -> Path:
    root = git_common_dir(repo) / "native-windows-receipts"
    return root / ("operation-" + sha256(str(canonical(repo))) + ".lock")


@contextmanager
def operation_lock(repo: Path, context: dict | None):
    """Coordinate lifecycle callbacks with the PowerShell FileShare.None lease."""
    path = operation_lock_path(repo, context)
    no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    no_links(path.parent)
    stream = path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            stream.seek(0)
            if path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)
        finally:
            stream.close()


def record_path(directory: Path, generation: str) -> Path:
    return directory / (OWNER + "-" + generation + ".json")


def write_latest(directory: Path, key: str, repo: Path, state: str,
                 receipt: Path | None = None) -> None:
    value = {"schema": SCHEMA, "owner": OWNER, "repo": str(repo), "state": state}
    if receipt is not None:
        value["receipt"] = str(receipt)
    atomic_json(latest_path(directory, key), value)


def lifecycle_register(context: dict, record: dict) -> None:
    root = Path(record["output"])
    if root.exists() or root.is_symlink():
        die("generation root appeared before lifecycle registration")
    callback = [sys.executable, str(Path(__file__).resolve()), "complete", "--receipt",
                record["receipt"], "--result-ref", "{result_ref}", "--users-released"]
    command = [*context["owner_receipt_argv"], "--owner", OWNER,
               "--generation", record["generation"], "--receipt", record["receipt"],
               "--output", record["output"], "--completion-json", compact(callback)]
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        die("lifecycle owner receipt registration failed: " + result.stderr.strip())


def active_records(directory: Path, repo: Path) -> list[dict]:
    if not directory.exists():
        return []
    records = []
    for path in directory.glob(OWNER + "-*.json"):
        record = read_json(path)
        if record.get("repo") == str(repo) and record.get("state") == "active":
            records.append(record)
    return records


def begin(repo: Path | str, inputs: dict, *, context: dict | None = None) -> dict:
    repo = canonical(repo)
    if not repo.is_dir():
        die("repo does not exist")
    validate_inputs(repo, inputs)
    reclamation_api()
    context = context if context is not None else context_from_env(repo)
    directory = receipt_directory(repo, context)
    directory.mkdir(parents=True, exist_ok=True)
    if active_records(directory, repo):
        die("an active Windows build generation must be failed or sealed before begin")
    key = receipt_key(repo, context)
    write_latest(directory, key, repo, "invalidated")
    generation = uuid.uuid4().hex
    root = repo / "src-tauri" / "target" / "native-generations" / generation
    receipt = record_path(directory, generation)
    no_links(root)
    no_links(receipt)
    if root.exists() or root.is_symlink() or receipt.exists():
        die("refusing to claim a preexisting Windows build generation")
    record = {
        "schema": SCHEMA, "owner": OWNER, "generation": generation, "receipt": str(receipt),
        "repo": str(repo), "task": context.get("task") if context else None, "output": str(root),
        "source_revision": source_revision(repo), "input_snapshot": copy.deepcopy(inputs),
        "inputs": [copy.deepcopy(inputs)], "state": "active",
        "hold": False, "proofs": {}, "identity": {},
    }
    if context is not None:
        lifecycle_register(context, record)
    atomic_json(receipt, record)
    if root.exists() or root.is_symlink():
        die("generation root appeared before creation")
    _checkpoint("before-root-create", str(root))
    root.mkdir(parents=True)
    no_links(root)
    _checkpoint("after-root-create", str(root))
    record["identity"] = {"root": identity(root)}
    atomic_json(receipt, record)
    return {"receipt": str(receipt), "output": str(root), "generation": generation}


def record_for(receipt: Path | str) -> tuple[Path, dict]:
    path = canonical(receipt)
    record = read_json(path)
    if record.get("schema") != SCHEMA or record.get("owner") != OWNER or record.get("receipt") != str(path):
        die("receipt is not a Windows build owner receipt")
    if record.get("state") not in STATES:
        die("receipt has an invalid state")
    repo = canonical(record.get("repo", ""))
    generation = record.get("generation")
    if not isinstance(generation, str) or len(generation) != 32 or any(char not in "0123456789abcdef" for char in generation):
        die("receipt has an invalid generation")
    expected_output = repo / "src-tauri" / "target" / "native-generations" / generation
    if normalized_absolute(record.get("output", "")) != normalized_absolute(expected_output):
        die("receipt output is outside its dedicated generation root")
    context = context_from_env(repo)
    if path.parent != registered_receipt_directory(repo, record, context):
        die("receipt is outside the registered owner receipt directory")
    return path, record


def require_same_inputs(record: dict, inputs: dict) -> None:
    if compact(record.get("input_snapshot")) != compact(inputs):
        die("immutable Windows build inputs changed")


def seal(receipt: Path | str, inputs: dict) -> dict:
    path, record = record_for(receipt)
    if record["state"] != "active":
        die("only an active Windows build generation can be sealed")
    repo = canonical(record["repo"])
    validate_inputs(repo, inputs)
    require_same_inputs(record, inputs)
    root = Path(record["output"])
    no_links(root)
    root_identity = record.get("identity", {}).get("root")
    if not isinstance(root_identity, list) or len(root_identity) != 2:
        die("active generation lacks a root identity")
    manifest = tree_manifest(root, root_identity)
    reject_intermediates(manifest)
    deploy = deploy_files(root)
    dist = dist_files(repo)
    reclamation = reclamation_api()
    try:
        capture = reclamation.capture(root, manifest, root_identity)
    except Exception as exc:
        die("cannot capture sealed Windows generation: " + str(exc))
    record["manifest"] = manifest
    record["capture"] = capture
    record["deploy_files"] = deploy
    record["dist_files"] = dist
    record["proofs"] = {"tree_sha256": sha256(compact({"manifest": manifest, "capture": capture,
                                                          "deploy": deploy, "dist": dist}))}
    record["sha256"] = record["proofs"]["tree_sha256"]
    record["success"] = True
    record["state"] = "sealed"
    atomic_json(path, record)
    context = context_from_env(repo)
    directory = path.parent
    write_latest(directory, receipt_key(repo, context), repo, "sealed", path)
    return {"receipt": str(path), "generation": record["generation"], "state": "sealed"}


def fail(receipt: Path | str) -> dict:
    path, record = record_for(receipt)
    if record["state"] != "active":
        die("only an active Windows build generation can fail")
    _capture_failed(path, record)
    repo = canonical(record["repo"])
    context = context_from_env(repo)
    write_latest(path.parent, receipt_key(repo, context), repo, "invalidated")
    return {"receipt": str(path), "generation": record["generation"], "state": "failed"}


def _capture_failed(path: Path, record: dict) -> None:
    """Freeze a failed private generation so acceptance may reclaim it later."""
    root = Path(record["output"])
    root_identity = record.get("identity", {}).get("root")
    if not isinstance(root_identity, list) or len(root_identity) != 2:
        try:
            no_links(root)
        except OwnerError:
            _block_unproved(path, record, "generation root path traverses a link or reparse point without a durable identity")
            return
        if os.path.lexists(root):
            _block_unproved(path, record, "generation root exists without a durable identity")
            return
        record["manifest"] = []
        record["capture"] = {}
        record["no_output"] = True
        record["success"] = False
        record["proofs"] = {"no_output_sha256": sha256("no-output\0" + record["generation"])}
        record["sha256"] = record["proofs"]["no_output_sha256"]
        record["state"] = "failed"
        atomic_json(path, record)
        return
    try:
        manifest = tree_manifest(root, root_identity)
        reject_intermediates(manifest)
        capture = reclamation_api().capture(root, manifest, root_identity)
    except Exception as exc:
        _block_failed_capture(path, record, str(exc))
        return
    record["manifest"] = manifest
    record["capture"] = capture
    record["proofs"] = {"tree_sha256": sha256(compact({"manifest": manifest, "capture": capture}))}
    record["sha256"] = record["proofs"]["tree_sha256"]
    record["success"] = False
    record["state"] = "failed"
    atomic_json(path, record)


def _block_unproved(path: Path, record: dict, reason: str) -> None:
    record["success"] = False
    record["hold"] = True
    record["failure_reason"] = reason
    record["proofs"] = {"blocked_sha256": sha256("unproved-root\0" + record["generation"])}
    record["sha256"] = record["proofs"]["blocked_sha256"]
    record["state"] = "failed"
    atomic_json(path, record)


def _block_failed_capture(path: Path, record: dict, detail: str) -> None:
    """Retain an unsafe failed root without leaving an active owner lease."""
    reason = "failed generation capture refused: " + detail
    record["success"] = False
    record["hold"] = True
    record["failure_reason"] = reason
    record["proofs"] = {"blocked_sha256": sha256(compact({"generation": record["generation"],
                                                            "failure_reason": reason}))}
    record["sha256"] = record["proofs"]["blocked_sha256"]
    record["state"] = "failed"
    atomic_json(path, record)


def latest(repo: Path | str) -> dict:
    repo = canonical(repo)
    context = context_from_env(repo)
    directory = receipt_directory(repo, context)
    pointer = latest_path(directory, receipt_key(repo, context))
    value = read_json(pointer)
    if value.get("repo") != str(repo) or value.get("state") != "sealed" or not isinstance(value.get("receipt"), str):
        die("no successful Windows build generation is selected")
    path, record = record_for(value["receipt"])
    if record.get("repo") != str(repo) or record.get("state") != "sealed":
        die("selected Windows build generation is no longer sealed")
    return {"receipt": str(path), "output": record["output"], "generation": record["generation"]}


def invalidate(repo: Path | str) -> dict:
    repo = canonical(repo)
    context = context_from_env(repo)
    directory = receipt_directory(repo, context)
    write_latest(directory, receipt_key(repo, context), repo, "invalidated")
    return {"repo": str(repo), "state": "invalidated"}


def verify(receipt: Path | str, repo: Path | str, inputs: dict) -> dict:
    path, record = record_for(receipt)
    expected_repo = canonical(repo)
    if canonical(record["repo"]) != expected_repo or record["state"] != "sealed":
        die("receipt does not name a sealed generation for --repo")
    validate_inputs(expected_repo, inputs)
    require_same_inputs(record, inputs)
    root = Path(record["output"])
    no_links(root)
    root_identity = record["identity"]["root"]
    manifest = tree_manifest(root, root_identity)
    reject_intermediates(manifest)
    if manifest != record.get("manifest"):
        die("sealed Windows generation tree changed")
    deploy = deploy_files(root)
    if deploy != record.get("deploy_files"):
        die("sealed Windows deploy files changed")
    if dist_files(expected_repo) != record.get("dist_files"):
        die("sealed generated dist changed")
    try:
        capture = reclamation_api().capture(root, record["manifest"], root_identity)
    except Exception as exc:
        die("sealed Windows generation capture changed: " + str(exc))
    if capture != record.get("capture"):
        die("sealed Windows generation identity changed")
    files = []
    for relative, digest in sorted(deploy.items()):
        deployed = root / PurePosixPath(relative)
        files.append({"path": str(deployed), "name": deployed.name, "sha256": digest})
    return {"receipt": str(path), "output": str(root), "generation": record["generation"],
            "files": files, "verified": True}


def _reclaim(path: Path, record: dict) -> dict:
    if record.get("state") != "cleanup_pending":
        die("only cleanup-pending Windows generations can be reclaimed")
    if record.get("hold") is True:
        die("held Windows generation cannot be reclaimed")
    if (not isinstance(record.get("accepted_proof"), str)
            or record.get("accepted_proof") != record.get("released_proof")):
        die("Windows generation lacks acceptance or user-release proof")
    root = Path(record["output"])
    no_links(root)
    if record.get("no_output") is True:
        if os.path.lexists(root):
            die("no-output Windows generation root appeared after failure")
        record["state"] = "reclaimed"
        record["reclaim_result"] = {"removed": True, "observed_removals": 0, "no_output": True}
        atomic_json(path, record)
        return {"owner": OWNER, "receipt": str(path), "output": record["output"],
                "generation": record["generation"], "reclaimed": True}
    manifest = record.get("manifest")
    root_identity = record.get("identity", {}).get("root")
    capture = record.get("capture")
    if not isinstance(manifest, list) or not isinstance(root_identity, list) or not isinstance(capture, dict):
        die("sealed Windows generation lacks immutable reclamation proof")
    reclamation = reclamation_api()
    if "reclaim_progress" not in record:
        try:
            current = reclamation.capture(root, manifest, root_identity)
        except Exception as exc:
            die("Windows generation changed before reclaim: " + str(exc))
        if current != capture:
            die("Windows generation capture changed before reclaim")
        record["reclaim_progress"] = copy.deepcopy(capture)
        atomic_json(path, record)

    def persist() -> None:
        atomic_json(path, record)

    try:
        result = reclamation.remove_tree(root, manifest, root_identity, record["reclaim_progress"], persist)
    except Exception:
        # The durable pending state and progress are intentionally retained for resume.
        raise
    record["state"] = "reclaimed"
    record["reclaim_result"] = result
    atomic_json(path, record)
    return {"owner": OWNER, "receipt": str(path), "output": record["output"],
            "generation": record["generation"], "reclaimed": True}


def complete(receipt: Path | str, result_ref: str, users_released: bool) -> dict:
    if not isinstance(result_ref, str) or not result_ref:
        die("--result-ref must be nonempty")
    if not users_released:
        die("--users-released is required before reclaim")
    path, record = record_for(receipt)
    if record.get("state") == "reclaimed":
        if record.get("accepted_proof") != result_ref:
            die("completion result reference changed")
        return {"owner": OWNER, "receipt": str(path), "output": record["output"],
                "generation": record["generation"], "reclaimed": True}
    if record.get("state") not in {"sealed", "failed", "cleanup_pending"}:
        die("only sealed or failed Windows generations can be completed")
    if record.get("hold") is True:
        die("held Windows generation cannot be completed")
    task = record.get("task")
    if task is not None:
        try:
            from workspace_lifecycle import service
            if service.status(canonical(record["repo"]), task).get("hold"):
                die("managed lifecycle task is held")
        except OwnerError:
            raise
        except Exception as exc:
            die("cannot inspect managed lifecycle task hold: " + str(exc))
    accepted = record.get("accepted_proof")
    if accepted is not None and accepted != result_ref:
        die("completion result reference changed")
    record["accepted_proof"] = result_ref
    record["released_proof"] = result_ref
    record["state"] = "cleanup_pending"
    atomic_json(path, record)
    return _reclaim(path, record)


def resume(repo: Path | str) -> list[dict]:
    repo = canonical(repo)
    context = context_from_env(repo)
    directory = receipt_directory(repo, context)
    results = []
    for candidate in sorted(directory.glob(OWNER + "-*.json")) if directory.exists() else []:
        path, record = record_for(candidate)
        if record.get("repo") != str(repo):
            continue
        if record.get("state") == "active":
            try:
                _capture_failed(path, record)
            except OwnerError:
                continue
            results.append({"receipt": str(path), "generation": record["generation"], "state": "failed"})
        elif record.get("state") == "cleanup_pending":
            results.append(_reclaim(path, record))
    return results


def paths(repo: Path | str) -> dict:
    repo = canonical(repo)
    context = context_from_env(repo)
    directory = receipt_directory(repo, context)
    return {"receipt_directory": str(directory), "lock": str(operation_lock_path(repo, context)),
            "latest": str(latest_path(directory, receipt_key(repo, context)))}


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    begin_parser = commands.add_parser("begin")
    begin_parser.add_argument("--repo", required=True)
    begin_parser.add_argument("--inputs", required=True)
    seal_parser = commands.add_parser("seal")
    seal_parser.add_argument("--receipt", required=True)
    seal_parser.add_argument("--inputs", required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--receipt", required=True)
    verify_parser.add_argument("--repo", required=True)
    verify_parser.add_argument("--inputs", required=True)
    fail_parser = commands.add_parser("fail")
    fail_parser.add_argument("--receipt", required=True)
    complete_parser = commands.add_parser("complete")
    complete_parser.add_argument("--receipt", required=True)
    complete_parser.add_argument("--result-ref", required=True)
    complete_parser.add_argument("--users-released", action="store_true")
    resume_parser = commands.add_parser("resume")
    resume_parser.add_argument("--repo", required=True)
    latest_parser = commands.add_parser("latest")
    latest_parser.add_argument("--repo", required=True)
    invalidate_parser = commands.add_parser("invalidate")
    invalidate_parser.add_argument("--repo", required=True)
    paths_parser = commands.add_parser("paths")
    paths_parser.add_argument("--repo", required=True)
    args = parser.parse_args()
    try:
        if args.command == "begin":
            result = begin(args.repo, input_snapshot(args.inputs))
        elif args.command == "seal":
            result = seal(args.receipt, input_snapshot(args.inputs))
        elif args.command == "verify":
            result = verify(args.receipt, args.repo, input_snapshot(args.inputs))
        elif args.command == "fail":
            result = fail(args.receipt)
        elif args.command == "complete":
            _path, record = record_for(args.receipt)
            repo = canonical(record["repo"])
            with operation_lock(repo, context_from_env(repo)):
                result = complete(args.receipt, args.result_ref, args.users_released)
        elif args.command == "resume":
            repo = canonical(args.repo)
            with operation_lock(repo, context_from_env(repo)):
                result = resume(repo)
        elif args.command == "latest":
            result = latest(args.repo)
        elif args.command == "invalidate":
            result = invalidate(args.repo)
        else:
            result = paths(args.repo)
        print(compact(result))
        return 0
    except (OwnerError, OSError) as exc:
        print("funkot-player Windows build owner: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

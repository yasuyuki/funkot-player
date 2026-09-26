#!/usr/bin/env python3
"""Focused fake-Docker tests for the task-scoped player build owner."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
import types

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("player_owner", ROOT / "scripts/lifecycle-product-owner.py")
owner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(owner)


class FakeDocker:
    def __init__(self):
        self.events = []
        self.volumes = {}
        self.containers = set()
        self.fail_after_create = False

    def call(self, *argv, input=None):
        self.events.append(argv)
        if argv[:2] == ("info", "--format"):
            return "daemon-1\n"
        if argv[:2] == ("context", "inspect"):
            return "unix:///var/run/docker.sock\n"
        if argv[:3] == ("volume", "ls", "-q"):
            name = argv[4].removeprefix("name=^").removesuffix("$")
            return name + "\n" if name in self.volumes else ""
        if argv[:2] == ("volume", "inspect"):
            value = self.volumes.get(argv[2])
            if value is None:
                raise owner.OwnerError("not found")
            return json.dumps([value])
        if argv[:2] == ("volume", "create"):
            name = argv[3]
            labels = dict(part.split("=", 1) for key, part in zip(argv[4::2], argv[5::2]) if key == "--label")
            self.volumes[name] = {"Name": name, "CreatedAt": "2026-09-26T00:00:00Z", "Labels": labels}
            if self.fail_after_create:
                self.fail_after_create = False
                raise owner.OwnerError("simulated kill after volume create")
            return name + "\n"
        if argv[:2] == ("volume", "rm"):
            self.volumes.pop(argv[2])
            return argv[2] + "\n"
        if argv[:2] == ("ps", "-a"):
            return "container\n" if self.containers else ""
        if argv[:2] == ("run", "--rm"):
            return "b" * 64 + "  -\n"
        raise AssertionError(argv)


def check(value, message):
    if not value:
        raise AssertionError(message)


def main():
    tracked = subprocess.check_output(
        ["git", "ls-files", "src-tauri/gen"], cwd=ROOT, text=True).splitlines()
    tracked_hashes = {name: owner.file_sha256(ROOT / name, (ROOT / name).stat()) for name in tracked}
    with tempfile.TemporaryDirectory() as temporary:
        temp = Path(temporary)
        receipts = temp / "receipts"
        fake = FakeDocker()
        owner.docker = fake.call
        owner.docker_optional = lambda *argv: (None if argv[:2] == ("volume", "inspect") and argv[2] not in fake.volumes else fake.call(*argv))
        owner.source_revision = lambda repo: "a" * 40
        registered_argv = []
        original_run = owner.subprocess.run
        owner.subprocess.run = lambda argv, **kwargs: (registered_argv.append(argv) or types.SimpleNamespace(returncode=0, stderr=""))
        registration_record = {"output": str(temp / "generation"), "repo": str(ROOT),
                               "receipt": str(temp / "receipt.json"), "generation": "registration"}
        registration_context = {"owner_receipt_argv": ["register"]}
        owner.lifecycle_register(registration_context, registration_record)
        owner.subprocess.run = original_run
        check(registered_argv[0].count("--output") == 1 + len(owner.host_target_specs(ROOT)),
              "lifecycle registration omitted managed host output paths")
        registered = []
        def register(context, record):
            check(not Path(record["output"]).exists(), "output existed before registration")
            registered.append(record["generation"])
            fake.events.append(("register", record["generation"]))
        owner.lifecycle_register = register
        owner.uuid.uuid4 = lambda: types.SimpleNamespace(hex="g" * 32)
        context = {"version": 1, "owner_receipt_argv": ["register"], "owner_receipt_dir": str(receipts),
                   "repo": str(ROOT), "task": "issue-146"}
        package = sys.modules.get("workspace_lifecycle") or types.ModuleType("workspace_lifecycle")
        reclamation = types.ModuleType("workspace_lifecycle.reclamation")
        reclamation.capture = lambda root, manifest, identity: {"manifest_id": "preflight", "root_identity": identity, "members": manifest}
        reclamation.remove_tree = lambda root, manifest, identity, progress, persist: None
        package.reclamation = reclamation
        sys.modules["workspace_lifecycle"] = package
        sys.modules["workspace_lifecycle.reclamation"] = reclamation

        os.environ["FUNKOT_CARGO_TARGET"] = "owner-test-cargo"
        fake.fail_after_create = True
        try:
            owner.prepare(context)
        except owner.OwnerError as exc:
            check("simulated kill" in str(exc), "create interruption was not surfaced")
        else:
            raise AssertionError("create interruption unexpectedly succeeded")
        intent_path = receipts / (owner.OWNER + "-" + "g" * 32 + ".intent.json")
        interrupted = owner.read_json(intent_path)
        check(interrupted.get("cargo_create_expected"), "cargo create intent was not durable before create")
        record = owner.prepare(context)
        volume = record["volume"]["name"]
        node_volume = record["node_volume"]["name"]
        jni_volume = record["jni_volume"]["name"]
        for key, path_text in record["mounts"].items():
            path = Path(path_text)
            if key in owner.FILE_MOUNT_KEYS:
                check(path.is_file() and not path.is_symlink(), key + " external mount source is not a regular file")
            else:
                check(path.is_dir() and not path.is_symlink(), key + " external mount source is not a directory")
        check(registered == ["g" * 32], "one output was not registered")
        check(fake.events.index(("register", "g" * 32)) < next(i for i, e in enumerate(fake.events) if e[:2] == ("volume", "create")), "volume created before register")
        check(volume == "owner-test-cargo", "explicit Cargo target was not preserved")
        check(owner.prepare(context)["generation"] == record["generation"], "active generation was not reused")
        check(len([e for e in fake.events if e[:2] == ("volume", "create")]) == 3, "reuse created another volume")
        saved_target = os.environ.pop("FUNKOT_CARGO_TARGET")
        try:
            owner.prepare(context)
        except owner.OwnerError as exc:
            check("target choice changed" in str(exc), "unset custom target was accepted")
        else:
            raise AssertionError("unset custom target cleared ownership")
        os.environ["FUNKOT_CARGO_TARGET"] = "other-target"
        try:
            owner.prepare(context)
        except owner.OwnerError as exc:
            check("target choice changed" in str(exc), "switched custom target was accepted")
        else:
            raise AssertionError("switched custom target orphaned ownership")
        os.environ["FUNKOT_CARGO_TARGET"] = saved_target
        original_labels = dict(fake.volumes[volume]["Labels"])
        fake.volumes[volume]["Labels"]["jp.hatsuboshi.workspace-lifecycle.generation"] = "changed"
        try:
            owner.prepare(context)
        except owner.OwnerError as exc:
            check("identity changed" in str(exc), "changed labels were not refused")
        else:
            raise AssertionError("changed managed volume was accepted")
        fake.volumes[volume]["Labels"] = original_labels

        def capture(root, manifest, identity):
            check(isinstance(manifest, list), "manifest missing")
            return {"manifest_id": "m1", "root_identity": identity, "members": manifest}
        partial = {"first": True}
        def remove_tree(root, manifest, identity, progress, persist):
            persist()
            if partial["first"]:
                partial["first"] = False
                shutil.rmtree(root)
                raise RuntimeError("simulated interruption")
            if root.exists():
                shutil.rmtree(root)
            return {"removed": True, "observed_removals": 1, "manifest_id": "m1"}
        package = sys.modules.get("workspace_lifecycle") or types.ModuleType("workspace_lifecycle")
        reclamation = types.ModuleType("workspace_lifecycle.reclamation")
        reclamation.capture = capture
        reclamation.remove_tree = remove_tree
        package.reclamation = reclamation
        sys.modules["workspace_lifecycle"] = package
        sys.modules["workspace_lifecycle.reclamation"] = reclamation

        owner.seal(context, record["generation"], "funkot-player-dev", [])
        intent = owner.read_json(receipts / (owner.OWNER + "-" + record["generation"] + ".intent.json"))
        check(intent["state"] == "sealed" and intent["host_manifest"], "seal did not persist immutable proof")
        check(intent["jni_volume_proof"]["sha256"] == "b" * 64, "seal did not persist JNI volume proof")
        receipt = Path(record["receipt"])
        check(not receipt.exists(), "callback receipt unexpectedly preexisted")
        try:
            owner.reclaim(receipt, record["generation"], "result-ref")
        except RuntimeError:
            pass
        pending = owner.read_json(receipt)
        check(pending["state"] == "reclaim-pending" and pending["host_delete_intended"], "partial deletion was not durably journaled")
        owner.reclaim(receipt, record["generation"], "result-ref")
        complete = owner.read_json(receipt)
        check(complete["state"] == "reclaimed" and all(name not in fake.volumes for name in (volume, node_volume, jni_volume)), "retry did not complete exact receipt")
        check("funkot-player-cargo-registry" not in [str(e) for e in fake.events], "shared registry was touched")
        check("funkot-player-gradle" not in [str(e) for e in fake.events], "shared Gradle cache was touched")
        check("funkot-player-android-home" not in [str(e) for e in fake.events], "shared Android home was touched")

        # A receipt with a live container is refused before volume rm.
        fake.containers.add("container")
        fake.volumes[volume] = intent["volume"] | {"Name": volume, "CreatedAt": intent["volume"]["created_at"], "Labels": intent["volume"]["labels"]}
        complete["state"] = "reclaim-pending"
        complete["volume_delete_intended"] = False
        receipt.write_text(json.dumps(complete))
        try:
            owner.reclaim(receipt, record["generation"], "result-ref")
        except owner.OwnerError as exc:
            check("container" in str(exc), "container reference was not refused")
        else:
            raise AssertionError("container-referenced volume was removed")

    text = (ROOT / "dev.sh").read_text()
    for shared in ("funkot-player-cargo-registry", "funkot-player-gradle", "funkot-player-android-home"):
        check(shared in text, "unmanaged shared volume missing: " + shared)
    check("WORKSPACE_LIFECYCLE_CONTEXT" in text and "lifecycle-product-owner.py" in text, "managed dev integration missing")
    check('"$OWNER_ANDROID_JNI_VOLUME":"$PLAYER_MOUNT/src-tauri/gen/android/app/src/main/jniLibs"' in text,
          "managed JNI output is not mounted from its owned volume")
    for key in ("OWNER_ANDROID_PROJECT_BUILD", "OWNER_ANDROID_BUILDSRC_BUILD", "OWNER_ANDROID_BUILDSRC_GRADLE"):
        check(('"$' + key + '"') in text, key + " is not mounted from the owned generation root")
    check('--status "$status"' in text, "Docker exit status is not passed to owner cleanup")
    check("create_owner_file_mountpoint" not in text and 'rmdir "$PWD/node_modules"' not in text,
          "shell still creates or removes owner mountpoints")
    check('"mounts"]["android_jni"]' not in text, "managed JNI output still uses the host generation root")
    check({name: owner.file_sha256(ROOT / name, (ROOT / name).stat()) for name in tracked} == tracked_hashes,
          "focused owner test changed tracked Android sources")
    mountpoint_recovery_tests()
    fifo_refusal_tests()
    print("lifecycle product owner: OK")


def mountpoint_recovery_tests():
    original_specs = owner.host_target_specs
    original_checkpoint = owner._checkpoint
    try:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = root / "parent"
            parent.mkdir()
            targets = {"file": (parent / "placeholder", "file"),
                       "dir": (parent / "mount", "dir")}
            owner.host_target_specs = lambda repo: targets
            intent = root / "intent.json"
            owner.atomic_json(intent, {})

            # A real child exits after prepare has durably recorded every identity.
            child = os.fork()
            if child == 0:
                owner.prepare_mountpoints(intent, owner.read_json(intent), root)
                os._exit(73)
            _pid, status = os.waitpid(child, 0)
            check(os.WEXITSTATUS(status) == 73, "prepare child did not reach interruption point")
            prepared = owner.read_json(intent)
            owner.prepare_mountpoints(intent, prepared, root)

            # Kill after unlink but before any later state write; durable intent permits retry.
            child = os.fork()
            if child == 0:
                owner._checkpoint = lambda event, path: os._exit(74) if event == "after-mountpoint-remove" else None
                owner.cleanup_mountpoints(intent, owner.read_json(intent))
                os._exit(75)
            _pid, status = os.waitpid(child, 0)
            check(os.WEXITSTATUS(status) == 74, "cleanup child did not stop after exact unlink")
            owner.cleanup_mountpoints(intent, owner.read_json(intent))
            check(not any(path.exists() or path.is_symlink() for path, _kind in targets.values()),
                  "cleanup retry left a mountpoint")

            # A normal prepare after a kill at quarantine must finish deleting
            # the old inode before journaling a new incarnation.
            owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            child = os.fork()
            if child == 0:
                owner._checkpoint = lambda event, path: os._exit(78) if event == "after-mountpoint-quarantine" else None
                owner.cleanup_mountpoints(intent, owner.read_json(intent), {"file"})
                os._exit(79)
            _pid, status = os.waitpid(child, 0)
            check(os.WEXITSTATUS(status) == 78, "cleanup child did not stop after quarantine")
            quarantined = owner.read_json(intent)["host_mountpoints"]["file"]
            tombstone = Path(quarantined["path"]).parent / quarantined["tombstone"]
            check(tombstone.exists(), "quarantined inode was not retained for retry")
            old_fd = os.open(tombstone, os.O_RDONLY)
            resumed = owner.read_json(intent)
            owner.prepare_mountpoints(intent, resumed, root)
            current = owner.read_json(intent)["host_mountpoints"]["file"]
            check(current["identity"] != owner.stat_identity(os.fstat(old_fd)),
                  "prepare did not journal a new incarnation")
            os.close(old_fd)
            check(not tombstone.exists(), "prepare orphaned the old quarantined inode")
            owner.cleanup_mountpoints(intent, owner.read_json(intent))
            check(not any(parent.glob(".*.owner-*")), "cleanup left an owner tombstone")

            # Deletion intent permits a new, separately journaled incarnation for the next run.
            resumed = owner.read_json(intent)
            owner.prepare_mountpoints(intent, resumed, root)
            check(all(path.exists() for path, _kind in targets.values()), "next invocation did not recreate mountpoints")
            owner.cleanup_mountpoints(intent, owner.read_json(intent))

            # A create-to-journal crash is held as unknown rather than adopted.
            owner.atomic_json(intent, {})
            child = os.fork()
            if child == 0:
                owner._checkpoint = lambda event, path: os._exit(76) if event == "after-mountpoint-create" else None
                owner.prepare_mountpoints(intent, owner.read_json(intent), root)
                os._exit(77)
            _pid, status = os.waitpid(child, 0)
            check(os.WEXITSTATUS(status) == 76, "creation interruption was not reached")
            try:
                owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            except owner.OwnerError as exc:
                check("unproved" in str(exc), "unjournaled mountpoint was not held")
            else:
                raise AssertionError("unjournaled mountpoint was adopted")
            for path, _kind in targets.values():
                if path.is_dir() and not path.is_symlink(): path.rmdir()
                elif path.exists() or path.is_symlink(): path.unlink()

            # Unknown preexisting paths and links are never claimed.
            targets["file"][0].write_text("unknown")
            for expected in ("unproved",):
                try: owner.prepare_mountpoints(intent, {}, root)
                except owner.OwnerError as exc: check(expected in str(exc), "unknown path refusal changed")
                else: raise AssertionError("unknown preexisting path was adopted")
            targets["file"][0].unlink()
            targets["file"][0].symlink_to(parent / "elsewhere")
            try: owner.prepare_mountpoints(intent, {}, root)
            except owner.OwnerError as exc: check("unproved" in str(exc), "link refusal changed")
            else: raise AssertionError("preexisting link was adopted")
            targets["file"][0].unlink()

            # Replacement, unexpected bytes, and external hardlinks all stop cleanup.
            owner.atomic_json(intent, {})
            record = owner.read_json(intent); owner.prepare_mountpoints(intent, record, root)
            targets["file"][0].unlink(); targets["file"][0].touch()
            try: owner.cleanup_mountpoints(intent, owner.read_json(intent))
            except owner.OwnerError as exc: check("identity changed" in str(exc), "replacement refusal changed")
            else: raise AssertionError("replacement mountpoint was removed")
            check(targets["file"][0].exists() and targets["dir"][0].exists(),
                  "replacement refusal removed another mountpoint")
            targets["file"][0].unlink()
            targets["dir"][0].rmdir()
            # Restore the proved inode only by starting an isolated test record.
            owner.atomic_json(intent, {}); owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            targets["dir"][0].joinpath("bytes").write_text("x")
            try: owner.cleanup_mountpoints(intent, owner.read_json(intent))
            except owner.OwnerError as exc: check("contains bytes" in str(exc), "nonempty refusal changed")
            else: raise AssertionError("nonempty mountpoint was removed")
            targets["dir"][0].joinpath("bytes").unlink()
            os.link(targets["file"][0], parent / "outside-link")
            try: owner.cleanup_mountpoints(intent, owner.read_json(intent))
            except owner.OwnerError as exc: check("hardlink count changed" in str(exc), "hardlink refusal changed")
            else: raise AssertionError("externally hardlinked mountpoint was removed")
            (parent / "outside-link").unlink()
            owner.cleanup_mountpoints(intent, owner.read_json(intent))

            # A replacement installed after quarantine is retained with the proved tombstone.
            owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            def replace_after_quarantine(event, value):
                if event == "after-mountpoint-quarantine" and value.endswith("placeholder"):
                    Path(value).write_text("replacement")
            owner._checkpoint = replace_after_quarantine
            try: owner.cleanup_mountpoints(intent, owner.read_json(intent))
            except owner.OwnerError as exc: check("replaced after quarantine" in str(exc), "post-check replacement refusal changed")
            else: raise AssertionError("post-check replacement was removed")
            check(targets["file"][0].read_text() == "replacement", "replacement bytes were removed")
            owner._checkpoint = original_checkpoint

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); real = root / "real"; real.mkdir()
            linked = root / "linked"; linked.symlink_to(real, target_is_directory=True)
            owner.host_target_specs = lambda repo: {"file": (linked / "placeholder", "file")}
            try: owner.prepare_mountpoints(root / "intent.json", {}, root)
            except OSError: pass
            else: raise AssertionError("symlinked ancestor was followed")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); parent = root / "parent"; parent.mkdir()
            target = parent / "placeholder"
            owner.host_target_specs = lambda repo: {"file": (target, "file")}
            intent = root / "intent.json"; owner.atomic_json(intent, {})
            owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            saved = owner.read_json(intent)
            # Raw mount IDs matter within one mount session, but are deliberately
            # ignored after a simulated reboot/namespace change.
            changed_session = json.loads(json.dumps(saved))
            changed_session["host_mountpoints"]["file"]["mount_session"] = ["other", 1]
            changed_session["host_mountpoints"]["file"]["mount_id"] += 1000
            owner.validate_mountpoint(changed_session["host_mountpoints"]["file"], empty=True)
            original_mount_id = owner.fd_mount_id
            owner.fd_mount_id = lambda descriptor: original_mount_id(descriptor) + 1
            try: owner.validate_mountpoint(saved["host_mountpoints"]["file"], empty=True)
            except owner.OwnerError as exc: check("mount identity changed" in str(exc), "same-session mount replacement refusal changed")
            else: raise AssertionError("same-session mount replacement was accepted")
            owner.fd_mount_id = original_mount_id
            owner.cleanup_mountpoints(intent, owner.read_json(intent))
            parent.rename(root / "old-parent"); parent.mkdir()
            try: owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            except owner.OwnerError as exc: check("parent changed" in str(exc), "changed parent recreation refusal changed")
            else: raise AssertionError("missing mountpoint was recreated below a replacement parent")
            try: owner.cleanup_mountpoints(intent, owner.read_json(intent))
            except owner.OwnerError as exc: check("parent changed" in str(exc), "missing-path cleanup parent refusal changed")
            else: raise AssertionError("missing path below a replacement parent was accepted as removed")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); parent = root / "parent"; parent.mkdir()
            target = parent / "placeholder"
            owner.host_target_specs = lambda repo: {"file": (target, "file")}
            intent = root / "intent.json"; owner.atomic_json(intent, {})
            owner.prepare_mountpoints(intent, owner.read_json(intent), root)
            saved = owner.read_json(intent); entry = saved["host_mountpoints"]["file"]
            entry["tombstone"] = ".placeholder.owner-static"
            saved.setdefault("host_mountpoint_delete_intents", {})["file"] = True
            owner.atomic_json(intent, saved)
            dangling = parent / entry["tombstone"]
            dangling.symlink_to(parent / "absent")
            try: owner.cleanup_mountpoints(intent, owner.read_json(intent))
            except (OSError, owner.OwnerError): pass
            else: raise AssertionError("unexpected dangling tombstone was overwritten")
            check(target.exists() and dangling.is_symlink(), "unknown tombstone or original was removed")
    finally:
        owner.host_target_specs = original_specs
        owner._checkpoint = original_checkpoint


def fifo_refusal_tests():
    # Keep blocking regressions in bounded children, never in the test owner process.
    child = r"""
import importlib.util, os, stat, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("owner", sys.argv[1])
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
target = Path(sys.argv[2])
if sys.argv[3] == "static":
    os.mkfifo(target)
else:
    target.touch()
    original_stat = os.stat
    def replace_after_stat(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        if path == target.name and kwargs.get("follow_symlinks") is False:
            target.unlink()
            os.mkfifo(target)
        return result
    owner.os.stat = replace_after_stat
try:
    owner.path_identity(target, "file")
except owner.OwnerError as exc:
    assert "type" in str(exc), str(exc)
else:
    raise AssertionError("FIFO was accepted as a regular mountpoint")
assert stat.S_ISFIFO(target.lstat().st_mode), "refusal removed the FIFO"
print("FIFO refused and retained")
"""
    with tempfile.TemporaryDirectory() as temporary:
        for mode in ("static", "after-stat"):
            result = subprocess.run(
                [sys.executable, "-B", "-c", child, str(ROOT / "scripts/lifecycle-product-owner.py"),
                 str(Path(temporary) / mode), mode],
                capture_output=True, text=True, timeout=5)
            check(result.returncode == 0, mode + ": " + result.stderr)
            check("FIFO refused and retained" in result.stdout, mode + " did not complete refusal")


if __name__ == "__main__":
    main()

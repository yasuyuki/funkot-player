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
    with tempfile.TemporaryDirectory() as temporary:
        temp = Path(temporary)
        receipts = temp / "receipts"
        fake = FakeDocker()
        owner.docker = fake.call
        owner.docker_optional = lambda *argv: (None if argv[:2] == ("volume", "inspect") and argv[2] not in fake.volumes else fake.call(*argv))
        owner.source_revision = lambda repo: "a" * 40
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
        check(registered == ["g" * 32], "one output was not registered")
        check(fake.events.index(("register", "g" * 32)) < next(i for i, e in enumerate(fake.events) if e[:2] == ("volume", "create")), "volume created before register")
        check(volume == "owner-test-cargo", "explicit Cargo target was not preserved")
        check(owner.prepare(context)["generation"] == record["generation"], "active generation was not reused")
        check(len([e for e in fake.events if e[:2] == ("volume", "create")]) == 2, "reuse created another volume")
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
        check(complete["state"] == "reclaimed" and volume not in fake.volumes, "retry did not complete exact receipt")
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
    print("lifecycle product owner: OK")


if __name__ == "__main__":
    main()

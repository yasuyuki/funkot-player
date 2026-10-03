#!/usr/bin/env python3
"""Behavior tests for the Windows-native build generation owner."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from workspace_lifecycle import producers, service
from workspace_lifecycle.state import locked_state


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("win_build_owner", ROOT / "scripts" / "win-build-owner.py")
owner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(owner)


class WindowsBuildOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "player"
        self.repo.mkdir()
        (self.repo / "src-tauri").mkdir()
        (self.repo / "seed").write_text("fixture", encoding="utf-8")
        self.git("init")
        self.git("add", "seed")
        self.git("-c", "user.name=Owner Test", "-c", "user.email=owner@example.test",
                 "commit", "-m", "fixture")
        self.shared_build = self.root / "shared-build"
        self.shared_build.mkdir()
        (self.shared_build / "cache-marker").write_text("retain", encoding="utf-8")
        self.inputs = {
            "source_revision": "fixture", "sources": {}, "core": "fixture", "core_revision": "fixture",
            "core_pin": "fixture", "candidate": None, "cargo": "fixture", "rustc": "fixture",
            "npm": "fixture", "tauri": "fixture", "build_directory": str(self.shared_build),
            "target_directory": str(self.repo / "src-tauri" / "target"), "configurations": {},
            "flags": {}, "recipe": "fixture", "profile": "release",
        }
        self.previous_context = os.environ.pop("WORKSPACE_LIFECYCLE_CONTEXT", None)

    def tearDown(self):
        if self.previous_context is not None:
            os.environ["WORKSPACE_LIFECYCLE_CONTEXT"] = self.previous_context
        self.temporary.cleanup()

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def build_output(self, result, *, executable=b"exe", library=b"dll"):
        output = Path(result["output"])
        release = output / "release"
        release.mkdir(parents=True)
        (release / "funkot-player.exe").write_bytes(executable)
        (release / "runtime.dll").write_bytes(library)
        dist = self.repo / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("built", encoding="utf-8")
        return output

    def new_sealed(self):
        begun = owner.begin(self.repo, self.inputs)
        output = self.build_output(begun)
        owner.seal(begun["receipt"], self.inputs)
        return begun, output

    def test_seal_verify_and_reclaim_uses_installed_reclamation(self):
        begun, output = self.new_sealed()
        verified = owner.verify(begun["receipt"], self.repo, self.inputs)
        self.assertTrue(verified["verified"])
        self.assertEqual([item["name"] for item in verified["files"]],
                         ["funkot-player.exe", "runtime.dll"])
        self.assertTrue(all(Path(item["path"]).is_file() for item in verified["files"]))
        completed = owner.complete(begun["receipt"], "result-1", True)
        self.assertTrue(completed["reclaimed"])
        self.assertFalse(output.exists())
        self.assertTrue((self.repo / "dist" / "index.html").exists())
        self.assertEqual((self.shared_build / "cache-marker").read_text(encoding="utf-8"), "retain")

    def test_verify_refuses_changed_inputs_hashes_dist_and_intermediates(self):
        begun, output = self.new_sealed()
        wrong = dict(self.inputs)
        wrong["recipe"] = "other"
        with self.assertRaisesRegex(owner.OwnerError, "inputs changed"):
            owner.verify(begun["receipt"], self.repo, wrong)
        executable = output / "release" / "funkot-player.exe"
        executable.write_bytes(b"changed")
        with self.assertRaisesRegex(owner.OwnerError, "tree changed"):
            owner.verify(begun["receipt"], self.repo, self.inputs)
        executable.write_bytes(b"exe")
        (self.repo / "dist" / "index.html").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(owner.OwnerError, "generated dist changed"):
            owner.verify(begun["receipt"], self.repo, self.inputs)
        (self.repo / "dist" / "index.html").write_text("built", encoding="utf-8")
        (output / "release" / "deps").mkdir()
        with self.assertRaisesRegex(owner.OwnerError, "intermediate"):
            owner.verify(begun["receipt"], self.repo, self.inputs)

    def test_failed_build_invalidates_old_latest_and_refuses_preexisting_root(self):
        old, _output = self.new_sealed()
        owner.invalidate(self.repo)
        with self.assertRaisesRegex(owner.OwnerError, "no successful"):
            owner.latest(self.repo)
        active = owner.begin(self.repo, self.inputs)
        with self.assertRaisesRegex(owner.OwnerError, "no successful"):
            owner.latest(self.repo)
        owner.fail(active["receipt"])
        with self.assertRaisesRegex(owner.OwnerError, "no successful"):
            owner.latest(self.repo)
        original_uuid = owner.uuid.uuid4
        owner.uuid.uuid4 = lambda: type("FixedUuid", (), {"hex": "a" * 32})()
        try:
            expected = self.repo / "src-tauri" / "target" / "native-generations" / ("a" * 32)
            expected.mkdir(parents=True)
            with self.assertRaisesRegex(owner.OwnerError, "preexisting"):
                owner.begin(self.repo, self.inputs)
        finally:
            owner.uuid.uuid4 = original_uuid
        self.assertEqual(owner.record_for(old["receipt"])[1]["state"], "sealed")

    def test_failed_generation_requires_release_then_reclaims_only_its_root(self):
        begun = owner.begin(self.repo, self.inputs)
        output = Path(begun["output"])
        (output / "partial").write_text("failed", encoding="utf-8")
        owner.fail(begun["receipt"])
        failed = owner.read_json(Path(begun["receipt"]))
        self.assertEqual(failed["state"], "failed")
        self.assertFalse(failed["success"])
        self.assertTrue(failed["sha256"])
        self.assertTrue(output.exists())
        completed = owner.complete(begun["receipt"], "result-failed", True)
        self.assertTrue(completed["reclaimed"])
        self.assertFalse(output.exists())
        self.assertEqual((self.shared_build / "cache-marker").read_text(encoding="utf-8"), "retain")

    def test_resume_terminalizes_crashes_without_adopting_an_unproved_root(self):
        checkpoint = owner._checkpoint
        try:
            owner._checkpoint = lambda event, _path: (_ for _ in ()).throw(RuntimeError("before root")) \
                if event == "before-root-create" else None
            with self.assertRaisesRegex(RuntimeError, "before root"):
                owner.begin(self.repo, self.inputs)
            recovered = owner.resume(self.repo)
            self.assertEqual(recovered[0]["state"], "failed")
            no_output = owner.record_for(recovered[0]["receipt"])[1]
            self.assertTrue(no_output["no_output"])
            self.assertFalse(no_output["hold"])
            completed = owner.complete(recovered[0]["receipt"], "result-no-output", True)
            self.assertTrue(completed["reclaimed"])

            owner._checkpoint = lambda event, _path: (_ for _ in ()).throw(RuntimeError("after root")) \
                if event == "after-root-create" else None
            with self.assertRaisesRegex(RuntimeError, "after root"):
                owner.begin(self.repo, self.inputs)
            blocked = owner.resume(self.repo)
            self.assertEqual(blocked[0]["state"], "failed")
            unproved = owner.record_for(blocked[0]["receipt"])[1]
            self.assertTrue(unproved["hold"])
            self.assertEqual(unproved["failure_reason"], "generation root exists without a durable identity")
            self.assertTrue(Path(unproved["output"]).exists())
            owner._checkpoint = checkpoint
            next_generation = owner.begin(self.repo, self.inputs)
            self.assertNotEqual(next_generation["generation"], unproved["generation"])
        finally:
            owner._checkpoint = checkpoint

    def test_operation_lock_is_common_to_managed_and_unmanaged_calls(self):
        self.assertEqual(owner.operation_lock_path(self.repo, None),
                         owner.operation_lock_path(self.repo, {"task": "separate"}))
        self.assertEqual(owner.operation_lock_path(self.repo, None).parent,
                         owner.git_common_dir(self.repo) / "native-windows-receipts")

    def test_no_output_failure_refuses_a_root_that_appears_later(self):
        checkpoint = owner._checkpoint
        try:
            owner._checkpoint = lambda event, _path: (_ for _ in ()).throw(RuntimeError("before root")) \
                if event == "before-root-create" else None
            with self.assertRaisesRegex(RuntimeError, "before root"):
                owner.begin(self.repo, self.inputs)
            recovered = owner.resume(self.repo)
            receipt = recovered[0]["receipt"]
            failed = owner.record_for(receipt)[1]
            Path(failed["output"]).mkdir(parents=True)
            with self.assertRaisesRegex(owner.OwnerError, "appeared after failure"):
                owner.complete(receipt, "result-no-output", True)
            self.assertTrue(Path(failed["output"]).exists())
        finally:
            owner._checkpoint = checkpoint

    def test_capture_refusal_holds_failed_generation_and_allows_a_new_one(self):
        begun = owner.begin(self.repo, self.inputs)
        output = Path(begun["output"])
        partial = output / "partial"
        partial.write_text("partial", encoding="utf-8")
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.windll.kernel32
        kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.CreateFileW(str(partial), 0x80000000, 0, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            self.skipTest("cannot acquire a no-share fixture handle")
        try:
            owner.fail(begun["receipt"])
        finally:
            kernel.CloseHandle(handle)
        held = owner.record_for(begun["receipt"])[1]
        self.assertEqual(held["state"], "failed")
        self.assertTrue(held["hold"])
        self.assertIn("failed generation capture refused", held["failure_reason"])
        self.assertIn("root", held["identity"])
        self.assertEqual(held["input_snapshot"], self.inputs)
        self.assertTrue(output.exists())
        with self.assertRaisesRegex(owner.OwnerError, "held"):
            owner.complete(begun["receipt"], "result-held", True)
        next_generation = owner.begin(self.repo, self.inputs)
        self.assertNotEqual(next_generation["generation"], begun["generation"])

    def test_hold_retains_output_and_resume_retries_interrupted_real_removal(self):
        begun, output = self.new_sealed()
        receipt = Path(begun["receipt"])
        with self.assertRaisesRegex(owner.OwnerError, "users-released"):
            owner.complete(receipt, "result-2", False)
        self.assertTrue(output.exists())
        held = owner.read_json(receipt)
        held["hold"] = True
        owner.atomic_json(receipt, held)
        with self.assertRaisesRegex(owner.OwnerError, "held"):
            owner.complete(receipt, "result-2", True)
        self.assertTrue(output.exists())
        held["hold"] = False
        owner.atomic_json(receipt, held)
        reclamation = owner.reclamation_api()
        checkpoint = reclamation._checkpoint
        try:
            fired = {"value": False}
            def interrupt(event, _path):
                if event == "after-member-remove" and not fired["value"]:
                    fired["value"] = True
                    raise RuntimeError("interrupted reclaim")
            reclamation._checkpoint = interrupt
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                owner.complete(receipt, "result-2", True)
        finally:
            reclamation._checkpoint = checkpoint
        pending = owner.read_json(receipt)
        self.assertEqual(pending["state"], "cleanup_pending")
        self.assertIn("reclaim_progress", pending)
        completed = owner.resume(self.repo)
        self.assertEqual(len(completed), 1)
        self.assertFalse(output.exists())
        self.assertTrue((self.repo / "dist").exists())

    def test_managed_registration_and_callback_meet_producer_receipt_contract(self):
        remote = self.root / "origin.git"
        subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(remote)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.git("branch", "-M", "main")
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-u", "origin", "main")
        topic = self.root / "managed-topic"
        service.begin(self.repo, task="native", request="test/native", remote="origin",
                      branch="topic/native", worktree=str(topic),
                      validation=["git", "diff", "--check"],
                      preflight=["git", "-C", "{repo}", "status", "--porcelain"])
        from workspace_lifecycle.cli import _managed_context
        environment_keys = ("WORKSPACE_LIFECYCLE_CONTEXT", "WORKSPACE_LIFECYCLE_REPO",
                            "WORKSPACE_LIFECYCLE_TASK")
        previous = {key: os.environ.get(key) for key in environment_keys}
        os.environ.update(_managed_context(topic, "native"))
        try:
            inputs = dict(self.inputs)
            inputs["build_directory"] = str(self.shared_build)
            inputs["target_directory"] = str(topic / "src-tauri" / "target")
            begun = owner.begin(topic, inputs)
            output = Path(begun["output"])
            release = output / "release"
            release.mkdir(parents=True)
            (release / "funkot-player.exe").write_bytes(b"managed exe")
            (topic / "dist").mkdir()
            (topic / "dist" / "index.html").write_text("managed", encoding="utf-8")
            owner.seal(begun["receipt"], inputs)
            with locked_state(topic) as (_directory, state):
                registered = next(iter(state["tasks"]["native"]["owner_receipts"].values()))
            producers._run(registered, "result-managed", topic, "native")
            durable = owner.read_json(Path(begun["receipt"]))
            self.assertEqual(durable["state"], "reclaimed")
            self.assertEqual(durable["accepted_proof"], "result-managed")
            self.assertEqual(durable["released_proof"], "result-managed")
            self.assertIsInstance(durable["inputs"], list)
            self.assertTrue(durable["sha256"])
            self.assertFalse(output.exists())
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()

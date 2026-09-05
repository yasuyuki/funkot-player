"""Regression checks for rejecting mismatched inputs and failed verification."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("verify-portable.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerificationGuards(unittest.TestCase):
    def exercise(self, change=None, dirty="", status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "tool"
            binary.write_bytes(b"tool bytes")
            names = ("node", "npm", "rustc", "cargo")
            lock = {"source_set": {"player": "a" * 40, "engine": "a" * 40},
                    "toolchain": {name: "version" for name in names},
                    "tool_binaries_sha256": {name: hashlib.sha256(binary.read_bytes()).hexdigest() for name in names},
                    "build_environment": {},
                    "system_packages_sha256": hashlib.sha256(b"packages").hexdigest()}
            if change:
                change(lock)
            inputs = root / "inputs.json"
            inputs.write_text(json.dumps(lock))
            receipt = root / "receipt.json"
            statuses = iter(dirty) if isinstance(dirty, list) else None

            def output(*argv):
                if argv[0] == "git":
                    return (next(statuses) if statuses else dirty) if "status" in argv else "a" * 40
                return "packages" if argv[0] == "dpkg-query" else "version"

            with patch.object(sys, "argv", ["verify", str(inputs), str(receipt)]), \
                 patch.object(verify, "output", output), \
                 patch.object(verify.shutil, "which", return_value=str(binary)), \
                 patch.dict(verify.os.environ, {}, clear=True), \
                 patch.object(verify.subprocess, "run", return_value=subprocess.CompletedProcess([], status)) as run:
                try:
                    result = verify.main()
                except SystemExit:
                    self.assertFalse(run.called)
                    self.assertFalse(receipt.exists())
                    raise
            return result, json.loads(receipt.read_text()), run.call_count

    def test_wrong_source_rejected_before_checks(self):
        with self.assertRaisesRegex(SystemExit, "SHA differs"):
            self.exercise(lambda lock: lock["source_set"].update(player="b" * 40))

    def test_dirty_source_rejected_before_checks(self):
        with self.assertRaisesRegex(SystemExit, "uncommitted"):
            self.exercise(dirty=" M source")

    def test_same_version_different_bytes_rejected(self):
        with self.assertRaisesRegex(SystemExit, "tool bytes"):
            self.exercise(lambda lock: lock["tool_binaries_sha256"].update(node="wrong"))

    def test_failure_is_not_a_pass_or_skip(self):
        result, receipt, count = self.exercise(status=7)
        self.assertEqual((result, receipt["result"], count), (1, "fail", 1))
        self.assertEqual(receipt["checks"][0]["exit"], 7)
        self.assertEqual(receipt["checks"][0]["log_sha256"], hashlib.sha256(b"").hexdigest())

    def test_checks_cannot_change_input_and_pass(self):
        result, receipt, _ = self.exercise(dirty=["", "", " M source", ""])
        self.assertEqual((result, receipt["result"], receipt["input_changed"]), (1, "fail", "player"))


if __name__ == "__main__":
    unittest.main()

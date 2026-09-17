#!/usr/bin/env python3
"""Small isolated checks for check-cargo-updates.py failure classification."""
from __future__ import annotations

import os
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).with_name("check-cargo-updates.py")
CORE_CHECK = Path(__file__).with_name("check-funkot-core-commit.sh")
PIN = "16d414783f5f0c35bd74c3d2a75605fd8f8bd842"


class CargoUpdateCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        parent = Path(self.tmp.name)
        self.player = parent / "funkot-player"
        self.core = parent / "funkot-autodj-for-ui"
        (self.player / "scripts").mkdir(parents=True)
        (self.player / "src-tauri" / "src").mkdir(parents=True)
        self.core.mkdir()
        shutil.copy2(SOURCE, self.player / "scripts" / SOURCE.name)
        shutil.copy2(CORE_CHECK, self.player / "scripts" / CORE_CHECK.name)
        (self.player / "funkot-core.commit").write_text(PIN + "\n")
        (self.player / "src-tauri" / "Cargo.toml").write_text("[package]\nname='test'\nversion='0.1.0'\n")
        (self.player / "src-tauri" / "Cargo.lock").write_text("version = 4\n")
        (self.player / "src-tauri" / "src" / "lib.rs").write_text("// source\n")
        subprocess.run(["git", "init", "-q"], cwd=self.player, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=self.player, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=self.player, check=True)
        subprocess.run(["git", "add", "."], cwd=self.player, check=True)
        subprocess.run(["git", "commit", "-qm", "player"], cwd=self.player, check=True)
        subprocess.run(["git", "init", "-q"], cwd=self.core, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=self.core, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=self.core, check=True)
        (self.core / "core.rs").write_text("// core\n")
        subprocess.run(["git", "add", "."], cwd=self.core, check=True)
        subprocess.run(["git", "commit", "-qm", "core"], cwd=self.core, check=True)
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.core, text=True).strip()
        (self.player / "funkot-core.commit").write_text(actual + "\n")
        self.cargo = parent / "cargo"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def invoke(self, *, cargo_output="", exit_code=0, env=None, mutate=None, mutate_core=False):
        body = "#!/bin/sh\n"
        if mutate:
            body += f"printf changed > {mutate}\n"
        if mutate_core:
            body += "printf changed > ../funkot-autodj-for-ui/core.rs\n"
        body += f"printf '%s\\n' {cargo_output!r}\nexit {exit_code}\n"
        self.cargo.write_text(body)
        self.cargo.chmod(0o755)
        command = ["python3", "scripts/check-cargo-updates.py", "--cargo", str(self.cargo)]
        run_env = os.environ.copy()
        run_env.pop("GITHUB_STEP_SUMMARY", None)
        if env:
            run_env.update(env)
        return subprocess.run(command, cwd=self.player, env=run_env, text=True, capture_output=True)

    def test_realistic_none_and_candidates(self):
        result = self.invoke(cargo_output="Updating crates.io index\nLocking 123 packages to latest compatible versions\nnote: no changes")
        self.assertEqual(result.returncode, 0)
        self.assertIn("none", result.stdout)
        summary = Path(self.tmp.name) / "summary"
        result = self.invoke(
            cargo_output="    Updating serde v1.0.0 -> v1.0.1",
            env={"GITHUB_STEP_SUMMARY": str(summary)},
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("candidates", result.stdout)
        self.assertIn("Updating serde v1.0.0 -> v1.0.1", summary.read_text())

    def test_network_resolution_and_mutation_failures(self):
        result = self.invoke(cargo_output="network timeout", exit_code=1)
        self.assertEqual(result.returncode, 4)
        self.assertIn("network failure", result.stdout)
        result = self.invoke(cargo_output="failed to select a version", exit_code=1)
        self.assertEqual(result.returncode, 3)
        self.assertIn("resolution failure", result.stdout)
        for path in ("src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/src/lib.rs"):
            with self.subTest(path=path):
                result = self.invoke(mutate=path)
                self.assertEqual(result.returncode, 21)
                self.assertIn("mutation failure", result.stdout)
        result = self.invoke(mutate_core=True)
        self.assertEqual(result.returncode, 21)
        self.assertIn("core/core.rs", result.stdout)

    def test_android_generated_tree_is_not_a_cargo_input(self):
        credential = self.player / "src-tauri" / "gen" / "android" / "keystore.properties"
        credential.parent.mkdir(parents=True)
        credential.write_text("synthetic-not-read\n")
        spec = importlib.util.spec_from_file_location("candidate_check", SOURCE)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        self.assertNotIn("player/src-tauri/gen/android/keystore.properties", module.snapshot_player(self.player))

    def test_missing_cargo_tool(self):
        command = ["python3", "scripts/check-cargo-updates.py", "--cargo", "does-not-exist-cargo"]
        run_env = os.environ.copy()
        run_env.pop("GITHUB_STEP_SUMMARY", None)
        result = subprocess.run(command, cwd=self.player, env=run_env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 5)
        self.assertIn("tool failure", result.stdout)

    def test_player_snapshot_does_not_need_git_metadata(self):
        (self.player / ".git").rename(self.player / ".git-not-mounted")
        result = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertIn("none", result.stdout)

    def test_rejects_candidate_and_wrong_sibling(self):
        result = self.invoke(env={"FUNKOT_CORE_CANDIDATE_SHA": PIN})
        self.assertEqual(result.returncode, 20)
        self.assertIn("core failure", result.stdout)

    def test_reports_missing_and_mismatched_core(self):
        shutil.rmtree(self.core)
        result = self.invoke()
        self.assertEqual(result.returncode, 20)
        self.assertIn("core failure", result.stdout)

    def test_reports_pin_mismatch(self):
        (self.player / "funkot-core.commit").write_text("0" * 40 + "\n")
        result = self.invoke()
        self.assertEqual(result.returncode, 20)
        self.assertIn("core failure", result.stdout)
        result = self.invoke(env={"FUNKOT_CORE_REPO": str(self.tmp.name)})
        self.assertEqual(result.returncode, 20)
        self.assertIn("core failure", result.stdout)


if __name__ == "__main__":
    unittest.main()

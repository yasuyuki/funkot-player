import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SPEC = importlib.util.spec_from_file_location(
    "source_switch_check", Path(__file__).with_name("check_source_switch.py")
)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class SourceSwitchResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        (self.tree / "verification/source_switch").mkdir(parents=True)
        self.out = self.tree / "evidence"
        self.out.mkdir()
        self.java = self.tree / "java-probe"
        self.marker = self.tree / "executed"

    def run_result(self, output, status=0, violation=None, started=None):
        self.java.write_text(
            "#!" + sys.executable + "\nimport pathlib,sys\n"
            + "pathlib.Path(" + repr(str(self.marker)) + ").touch()\n"
            + "print(" + repr(output) + ")\nsys.exit(" + str(status) + ")\n"
        )
        self.java.chmod(0o755)
        return CHECK.run_tlc(
            self.tree,
            self.out,
            str(self.java),
            self.tree / "jar",
            "probe",
            "fixture config",
            time.monotonic() if started is None else started,
            violation,
        )

    def test_zero_exit_without_complete_exploration_is_not_pass(self):
        for output in (
            "",
            "Model checking completed. No error has been found.",
            "0 states generated, 0 distinct states found, 0 states left on queue.",
            "2 states generated, 1 distinct states found, 1 states left on queue.\n"
            "Model checking completed. No error has been found.",
        ):
            with self.subTest(output=output), self.assertRaises(RuntimeError):
                self.run_result(output)

    def test_tool_error_is_not_a_negative_counterexample(self):
        violation = "Invariant NoStaleLoaderEffect is violated"
        output = (
            "Error: "
            + violation
            + "\nState 1: fixture\n2 states generated, 1 distinct states found, "
            + "1 states left on queue."
        )
        for status in (0, 1, 124, 255):
            with self.subTest(status=status), self.assertRaises(RuntimeError):
                self.run_result(output, status, violation)

    def test_missing_trace_is_not_a_negative_counterexample(self):
        violation = "Invariant NoStaleLoaderEffect is violated"
        with self.assertRaises(RuntimeError):
            self.run_result(
                violation
                + "\n2 states generated, 1 distinct states found, 1 states left on queue.",
                12,
                violation,
            )

    def test_expired_total_deadline_does_not_start_another_tool(self):
        with self.assertRaises(RuntimeError):
            self.run_result("", started=time.monotonic() - 15 * 60 - 1)
        self.assertFalse(self.marker.exists())

    def git(self, root, *args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

    def make_repo(self, name):
        root = self.tree / name
        root.mkdir()
        self.git(root, "init", "-q")
        self.git(root, "config", "user.email", "fixture@example.test")
        self.git(root, "config", "user.name", "Fixture")
        return root

    def commit(self, root):
        self.git(root, "add", ".")
        self.git(root, "commit", "-qm", "fixture")
        return self.git(root, "rev-parse", "HEAD")

    def clean_pair(self):
        player = self.make_repo("player")
        core = self.make_repo("core")
        (core / "funkot-core/src").mkdir(parents=True)
        (core / "funkot-core/src/engine.rs").write_text("engine\n")
        core_revision = self.commit(core)
        (player / "funkot-core.commit").write_text(core_revision + "\n")
        player_revision = self.commit(player)
        return player, core, player_revision, core_revision

    def assert_provenance_rejects_before_tlc(self, player, core):
        called = False
        original = CHECK.run_tlc

        def unexpected_tlc(*args, **kwargs):
            nonlocal called
            called = True
            raise AssertionError("TLC must not run before provenance validation")

        CHECK.run_tlc = unexpected_tlc
        try:
            with self.assertRaises(RuntimeError):
                CHECK.source_provenance(player, core)
        finally:
            CHECK.run_tlc = original
        self.assertFalse(called)

    def test_core_resolution_uses_public_sibling_layout_without_a_manifest(self):
        layout = self.tree / "layout"
        player = layout / "funkot-player"
        core = layout / "funkot-autodj-for-ui"
        player.mkdir(parents=True)
        core.mkdir()
        self.assertEqual(CHECK.selected_core_root(player), core.resolve())

    def test_malformed_working_set_does_not_fall_back_to_a_sibling(self):
        layout = self.tree / "malformed-layout"
        player = layout / "funkot-player"
        (layout / "funkot-autodj-for-ui").mkdir(parents=True)
        player.mkdir()
        (layout / "WORKING-SET.json").write_text("{not json")
        with self.assertRaisesRegex(RuntimeError, "cannot read the selected working set"):
            CHECK.selected_core_root(player)

    def test_main_records_malformed_working_set_before_tlc(self):
        layout = self.tree / "main-malformed-layout"
        script = layout / "funkot-player/verification/check_source_switch.py"
        script.parent.mkdir(parents=True)
        (layout / "WORKING-SET.json").write_text("{not json")
        out = self.tree / "main-malformed-evidence"
        original_file = CHECK.__file__
        original_argv = sys.argv
        original_tlc = CHECK.run_tlc
        called = False

        def unexpected_tlc(*args, **kwargs):
            nonlocal called
            called = True
            raise AssertionError("TLC must not run for a malformed working set")

        CHECK.__file__ = str(script)
        CHECK.run_tlc = unexpected_tlc
        sys.argv = ["check_source_switch.py", "--output", str(out)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(CHECK.main(), 1)
        finally:
            CHECK.__file__ = original_file
            CHECK.run_tlc = original_tlc
            sys.argv = original_argv

        self.assertFalse(called)
        summary = json.loads((out / "summary.json").read_text())
        self.assertEqual(summary["status"], "FAIL")
        self.assertIn("cannot read the selected working set", summary["error"])

    def test_provenance_rejects_missing_invalid_dirty_and_mismatched_repositories(self):
        player, core, _, core_revision = self.clean_pair()
        missing = self.tree / "missing"
        with self.subTest(case="missing player"):
            self.assert_provenance_rejects_before_tlc(missing, core)
        with self.subTest(case="missing core"):
            self.assert_provenance_rejects_before_tlc(player, missing)

        (player / "funkot-core.commit").write_text("not-a-commit\n")
        with self.subTest(case="invalid pin"):
            self.assert_provenance_rejects_before_tlc(player, core)
        (player / "funkot-core.commit").write_text(core_revision + "\n")

        (player / "dirty.txt").write_text("dirty\n")
        with self.subTest(case="dirty player"):
            self.assert_provenance_rejects_before_tlc(player, core)
        (player / "dirty.txt").unlink()

        (core / "dirty.txt").write_text("dirty\n")
        with self.subTest(case="dirty core"):
            self.assert_provenance_rejects_before_tlc(player, core)
        (core / "dirty.txt").unlink()

        other_core = self.make_repo("other-core")
        (other_core / "funkot-core/src").mkdir(parents=True)
        (other_core / "funkot-core/src/engine.rs").write_text("other\n")
        self.commit(other_core)
        with self.subTest(case="pin mismatch"):
            self.assert_provenance_rejects_before_tlc(player, other_core)


if __name__ == "__main__":
    unittest.main()

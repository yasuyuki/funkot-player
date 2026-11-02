import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "audition_check", Path(__file__).with_name("check_audition.py")
)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class AuditionSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        self.model = self.tree / "verification/audition/Audition.tla"
        self.model.parent.mkdir(parents=True)
        self.source = self.tree / "src-tauri/src/lib.rs"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("one\nAUDITION_LOCK.lock()?;\nthree\n")
        self.model.write_text(
            "Action ==\n"
            "    /\\ TRUE  \\* lib.rs:2 | AUDITION_LOCK.lock()?;\n"
        )

    def validate(self):
        return CHECK.validate_source_references(self.tree)

    def test_current_model_references_validate(self):
        player_root = Path(__file__).resolve().parents[1]
        self.assertEqual(CHECK.validate_source_references(player_root), 21)

    def test_inserted_line_above_cited_line_is_rejected(self):
        self.source.write_text("inserted\none\nAUDITION_LOCK.lock()?;\nthree\n")
        with self.assertRaisesRegex(RuntimeError, r"Audition.tla:2.*lib.rs:2"):
            self.validate()

    def test_changed_cited_text_is_rejected(self):
        self.source.write_text("one\nOTHER_LOCK.lock()?;\nthree\n")
        with self.assertRaisesRegex(RuntimeError, r"Audition.tla:2.*lib.rs:2"):
            self.validate()

    def test_invalid_or_missing_reference_metadata_is_rejected(self):
        for metadata in (
            "lib.rs:4 | AUDITION_LOCK.lock()?;",
            "lib.rs:2",
            "unknown.rs:2 | AUDITION_LOCK.lock()?;",
        ):
            with self.subTest(metadata=metadata):
                self.model.write_text("Action == /\\ TRUE  \\* " + metadata + "\n")
                with self.assertRaisesRegex(RuntimeError, r"Audition.tla:1"):
                    self.validate()

    def test_runner_rejects_bad_reference_before_tlc(self):
        self.model.write_text("Action == /\\ TRUE  \\* lib.rs:4 | AUDITION_LOCK.lock()?;\n")
        output = self.tree / "evidence"
        called = False
        original_file = CHECK.__file__
        original_argv = sys.argv
        original_revision = CHECK.shared.source_revision
        original_archive = CHECK.shared.archive_commit
        original_tlc = CHECK.shared.run_tlc

        def archive(_root, _revision, destination, _label):
            for path in (self.source, self.model):
                target = destination / path.relative_to(self.tree)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())

        def unexpected_tlc(*args, **kwargs):
            nonlocal called
            called = True
            raise AssertionError("TLC must not run before source-reference validation")

        CHECK.__file__ = str(self.tree / "verification/check_audition.py")
        CHECK.shared.source_revision = lambda _root, _label: "0" * 40
        CHECK.shared.archive_commit = archive
        CHECK.shared.run_tlc = unexpected_tlc
        sys.argv = ["check_audition.py", "--output", str(output)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(CHECK.main(), 1)
        finally:
            CHECK.__file__ = original_file
            CHECK.shared.source_revision = original_revision
            CHECK.shared.archive_commit = original_archive
            CHECK.shared.run_tlc = original_tlc
            sys.argv = original_argv

        self.assertFalse(called)
        summary = json.loads((output / "summary.json").read_text())
        self.assertEqual(summary["status"], "FAIL")
        self.assertRegex(summary["error"], r"Audition.tla:1.*lib.rs:4")


if __name__ == "__main__":
    unittest.main()

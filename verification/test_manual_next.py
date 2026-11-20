import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
SPEC = importlib.util.spec_from_file_location(
    "manual_next_check", Path(__file__).with_name("check_manual_next.py")
)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)

SOURCE = """fn dispatch_manual_next(playback: &Playback) -> Result<bool, String> {
    MANUAL_NEXT_IN_FLIGHT.store(true, Ordering::SeqCst);
    match playback.nav_tx.try_send(NavAction::TransitionToNext) {
        Ok(()) => Ok(true),
    }
}

fn other() {
    let x = 1;
}

#[cfg(test)]
mod tests {
    fn helper() {
        MANUAL_NEXT_PENDING.store(false, Ordering::SeqCst);
        dispatch_manual_next(&playback);
    }
}
"""
WRITERS = {"dispatch_manual_next": {"MANUAL_NEXT_IN_FLIGHT.store(": 1, "nav_tx.try_send(": 1}}


class ManualNextSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        model = self.tree / CHECK.SPEC
        model.parent.mkdir(parents=True)
        self.source = self.tree / CHECK.SOURCE
        self.source.parent.mkdir(parents=True)
        self.source.write_text(SOURCE)
        model.write_text(
            "Send ==\n"
            "    /\\ x' = 1  \\* lib.rs:dispatch_manual_next | match playback.nav_tx.try_send(NavAction::TransitionToNext) {\n"
        )

    def test_current_model_validates_against_the_checkout(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(CHECK.validate_source_references(root), CHECK.SOURCE_REFERENCE_COUNT)
        self.assertEqual(CHECK.validate_writers(root), CHECK.WRITERS)

    def test_reference_survives_moved_lines(self):
        self.source.write_text("// inserted\n\n" + SOURCE)
        self.assertEqual(CHECK.validate_source_references(self.tree, expected_count=1), 1)

    def test_changed_fragment_is_rejected(self):
        self.source.write_text(SOURCE.replace("try_send(", "send("))
        with self.assertRaisesRegex(RuntimeError, r"ManualNext.tla:2 expects fn dispatch_manual_next"):
            CHECK.validate_source_references(self.tree, expected_count=1)

    def test_renamed_function_is_rejected(self):
        self.source.write_text(SOURCE.replace("fn dispatch_manual_next", "fn dispatch_next"))
        with self.assertRaisesRegex(RuntimeError, r"no longer defines"):
            CHECK.validate_source_references(self.tree, expected_count=1)

    def test_writers_ignore_test_modules(self):
        self.assertEqual(CHECK.validate_writers(self.tree, expected=WRITERS), WRITERS)

    def test_new_writer_is_rejected(self):
        self.source.write_text(SOURCE.replace("    let x = 1;\n", "    MANUAL_NEXT_PENDING.store(false, Ordering::Release);\n"))
        with self.assertRaisesRegex(RuntimeError, r"manual Next writers changed"):
            CHECK.validate_writers(self.tree, expected=WRITERS)

    def test_config_selects_rules_and_break(self):
        cfg = 'SPECIFICATION Spec\nCONSTANTS\n  Break = "none"\nINVARIANTS\n  TypeOK\n  PressNotLost\n'
        self.assertEqual(
            CHECK.config_for(cfg, ("OneTrackPerPress",), '  Break = "no_waiter"\n'),
            'SPECIFICATION Spec\nCONSTANTS\n  Break = "no_waiter"\nINVARIANTS\n  TypeOK\n  OneTrackPerPress\n',
        )


if __name__ == "__main__":
    unittest.main()

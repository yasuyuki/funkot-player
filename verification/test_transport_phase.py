import importlib.util
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "transport_phase_check", Path(__file__).with_name("check_transport_phase.py")
)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)

SOURCE = """fn set_phase(p: Phase) {
    PHASE.store(p as u8, Ordering::Relaxed);
}

fn record_pause_change(paused: &AtomicBool, now_paused: bool) {
    if now_paused && get_phase() != Phase::Disconnected {
        set_phase(Phase::Paused);
    }
}

fn other() {
    let x = 1;
}

#[cfg(test)]
mod tests {
    fn helper() {
        set_phase(Phase::Idle);
    }
}
"""


class TransportPhaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        self.model = self.tree / CHECK.SPEC
        self.model.parent.mkdir(parents=True)
        self.source = self.tree / CHECK.SOURCE
        self.source.parent.mkdir(parents=True)
        self.source.write_text(SOURCE)
        self.model.write_text(
            "Write ==\n"
            "    /\\ phase' = \"paused\"  \\* lib.rs:record_pause_change | set_phase(Phase::Paused);\n"
        )

    def test_current_model_validates_against_the_checkout(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(CHECK.validate_source_references(root), CHECK.SOURCE_REFERENCE_COUNT)
        self.assertEqual(CHECK.validate_phase_writers(root), CHECK.PHASE_WRITERS)

    def test_reference_survives_moved_lines(self):
        self.source.write_text("// inserted\n\n" + SOURCE)
        self.assertEqual(CHECK.validate_source_references(self.tree, expected_count=1), 1)

    def test_fragment_outside_its_function_is_rejected(self):
        self.source.write_text(SOURCE.replace(
            "        set_phase(Phase::Paused);\n", "").replace("    let x = 1;\n", "    set_phase(Phase::Paused);\n"))
        with self.assertRaisesRegex(RuntimeError, r"TransportPhase.tla:2 expects fn record_pause_change"):
            CHECK.validate_source_references(self.tree, expected_count=1)

    def test_renamed_function_is_rejected(self):
        self.source.write_text(SOURCE.replace("fn record_pause_change", "fn record_pause"))
        with self.assertRaisesRegex(RuntimeError, r"no longer defines"):
            CHECK.validate_source_references(self.tree, expected_count=1)

    def test_writers_ignore_test_modules(self):
        self.assertEqual(
            CHECK.validate_phase_writers(self.tree, expected={"record_pause_change": 1}),
            {"record_pause_change": 1},
        )

    def test_new_writer_is_rejected(self):
        self.source.write_text(SOURCE.replace("    let x = 1;\n", "    set_phase(Phase::Playing);\n"))
        with self.assertRaisesRegex(RuntimeError, r"set_phase writers changed"):
            CHECK.validate_phase_writers(self.tree, expected={"record_pause_change": 1})

    def test_config_keeps_only_the_named_rules(self):
        cfg = "SPECIFICATION Spec\nINVARIANTS\n  TypeOK\n  A\n  B\n"
        self.assertEqual(CHECK.config_for(cfg, ("B",)), "SPECIFICATION Spec\nINVARIANTS\n  TypeOK\n  B\n")


if __name__ == "__main__":
    unittest.main()

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).with_name("adb-push-music-list.py")
DESTINATION = "/device/Music"
SPEC = importlib.util.spec_from_file_location("adb_push_music_list", SCRIPT)
TRANSFER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(TRANSFER)

FAKE_ADB = r'''import base64, json, os, shutil, sys
from pathlib import Path

root = Path(os.environ["FAKE_ADB_ROOT"])
dest = root / "Music"
args = sys.argv[1:]
if args == ["devices", "-l"]:
    print(os.environ.get("FAKE_DEVICES", "List of devices attached\nalias device model:Pixel_10_Pro"))
    raise SystemExit()
if len(args) < 5 or args[0] != "-s":
    raise SystemExit(9)
if args[2:] == ["shell", "getprop", "ro.serialno"]:
    print(os.environ.get("FAKE_SERIAL_" + args[1], "SERIAL"))
    raise SystemExit()
if args[2:] == ["shell", "getprop", "ro.product.model"]:
    print("Pixel 10 Pro")
    raise SystemExit()
if args[2:5] == ["shell", "sh", "-s"]:
    first = sys.stdin.readline().strip().split()
    data = json.loads(base64.b64decode(first[-1]).decode())
    kind = data["kind"]
    def path(name): return dest / Path(name)
    if kind == "identity": print(os.environ.get("FAKE_IDENTITY_SERIAL", "SERIAL") + "\nPixel 10 Pro")
    elif kind == "preflight":
        if not dest.is_dir() or dest.is_symlink(): raise SystemExit(31)
        if any(item.is_symlink() for item in dest.rglob("*")): raise SystemExit(32)
    elif kind == "inventory":
        for item in dest.rglob("*"):
            if item.is_file() and not item.name.endswith(".owner"):
                sys.stdout.buffer.write(item.relative_to(dest).as_posix().encode() + b"\0" + str(item.stat().st_size).encode() + b"\0")
    elif kind == "inspect":
        item = path(data["relative"])
        if item.is_symlink() or item.is_dir(): print("other\t-")
        elif item.is_file(): print("file\t" + str(item.stat().st_size))
        else: print("missing\t-")
    elif kind == "prepare":
        final, temp, owner = path(data["relative"]), path(data["temp"]), path(data["owner"])
        if final.exists() or final.is_symlink(): print("CONFLICT")
        else:
            temp.parent.mkdir(parents=True, exist_ok=True)
            if owner.exists() and owner.read_text() != data["stamp"]: print("CONFLICT")
            elif temp.exists() and not owner.exists(): print("CONFLICT")
            else:
                if not owner.exists(): owner.write_text(data["stamp"])
                print("READY")
    elif kind == "promote":
        final, temp, owner = path(data["relative"]), path(data["temp"]), path(data["owner"])
        if final.exists() or not temp.is_file() or temp.stat().st_size != data["size"] or not owner.is_file() or owner.read_text() != data["stamp"]: print("CONFLICT")
        else:
            temp.replace(final); owner.unlink(); print("COPIED")
    raise SystemExit()
if args[2] == "push":
    source, remote = Path(args[3]), args[4]
    target = dest / Path(remote).relative_to("/device/Music")
    target.parent.mkdir(parents=True, exist_ok=True)
    if os.environ.get("FAKE_PARTIAL") == "1":
        target.write_bytes(source.read_bytes()[:1]); raise SystemExit(1)
    shutil.copyfile(source, target)
    raise SystemExit()
raise SystemExit(9)
'''


class TransferCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.base = Path(self.tmp.name)
        self.app, self.music, self.device = self.base / "app", self.base / "music", self.base / "device"
        self.app.mkdir(); self.music.mkdir(); (self.device / "Music").mkdir(parents=True)
        self.fake = self.base / "fake_adb.py"
        self.fake.write_text(FAKE_ADB, encoding="utf-8")
        if os.name == "nt":
            self.launcher = self.base / "fake-adb.cmd"
            self.launcher.write_text(f'@echo off\r\n"{sys.executable}" "%~dp0fake_adb.py" %*\r\n', encoding="ascii")
        else:
            self.launcher = self.base / "fake-adb"
            self.launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{self.fake}" "$@"\n', encoding="utf-8")
            self.launcher.chmod(0o755)
        self.env = os.environ | {"FAKE_ADB_ROOT": str(self.device)}

    def tearDown(self):
        self.tmp.cleanup()

    def track(self, relative, digest, verdict=True, version=15):
        source = self.music / relative
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes((digest * 3).encode())
        entry = {"len": source.stat().st_size, "mtime_ms": source.stat().st_mtime_ns // 1_000_000, "hash": digest}
        index = json.loads((self.app / "hash-index.json").read_text()) if (self.app / "hash-index.json").exists() else {}
        index["C:\\Music\\" + relative.replace("/", "\\")] = entry
        (self.app / "hash-index.json").write_text(json.dumps(index), encoding="utf-8")
        cache = self.app / "funkot-cache"; cache.mkdir(exist_ok=True)
        (cache / f"{digest}.json").write_text(json.dumps({"version": version, "is_funkot": verdict}), encoding="utf-8")
        return source

    def profile(self, **extra):
        value = {"app_dir": str(self.app), "music_root": str(self.music), "adb": str(self.launcher), "device": "SERIAL", "model": "Pixel 10 Pro", "cache_version": 15, "destination": DESTINATION}
        value.update(extra)
        path = self.base / "profile.json"; path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def call(self, profile=None, *extra, env=None):
        command = [sys.executable, str(SCRIPT), "--profile", str(profile or self.profile()), *extra]
        return subprocess.run(command, text=True, capture_output=True, env=env or self.env)

    def snapshot(self):
        (self.app / "playback-state.json").write_text(json.dumps({"schema_version": 1, "settings": {"music_dir": "C:\\Music"}}), encoding="utf-8")

    def test_effective_override_unicode_copy_and_noop_rerun(self):
        self.snapshot()
        self.track("Beyoncé/O'Neil track.mp3", "a" * 64, False)
        self.track("ordinary.mp3", "b" * 64, False)
        self.track("manual exclusion.mp3", "c" * 64, True)
        (self.app / "library.json").write_text(json.dumps({"a" * 64: {"funkot": True}, "c" * 64: {"funkot": False}}), encoding="utf-8")
        first = self.call(); self.assertEqual(first.returncode, 0, first.stderr)
        summary = json.loads(first.stdout); self.assertEqual(summary["counts"]["copied"], 1); self.assertEqual(summary["counts"]["non_funkot"], 2)
        second = self.call(); self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(json.loads(second.stdout)["counts"]["existing"], 1)
        self.assertEqual((self.device / "Music" / "Beyoncé" / "O'Neil track.mp3").read_bytes(), (self.music / "Beyoncé" / "O'Neil track.mp3").read_bytes())

    def test_exclusions_and_corrupt_snapshot_do_not_fall_back(self):
        self.snapshot(); self.track("good.mp3", "a" * 64); self.track("old.mp3", "b" * 64, version="old")
        self.track("incomplete.mp3", "c" * 64)
        incomplete = self.app / "funkot-cache" / ("c" * 64 + ".json")
        incomplete.write_text(json.dumps({"version": 15, "is_funkot": True, "needs_reanalysis": True}), encoding="utf-8")
        result = self.call(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["counts"]["stale"], 1)
        self.assertEqual(json.loads(result.stdout)["counts"]["needs_reanalysis"], 1)
        (self.app / "playback-state.json").write_text("not json", encoding="utf-8")
        (self.app / "settings.json").write_text(json.dumps({"music_dir": "C:\\Music"}), encoding="utf-8")
        bad = self.call(); self.assertEqual(bad.returncode, 2); self.assertIn("playback-state", bad.stderr)

    def test_conflict_dry_run_and_owned_partial_rerun(self):
        self.snapshot(); source = self.track("space name.mp3", "a" * 64)
        final = self.device / "Music" / "space name.mp3"; final.write_bytes(b"wrong")
        conflict = self.call(); self.assertEqual(conflict.returncode, 1); self.assertEqual(final.read_bytes(), b"wrong")
        final.unlink()
        dry = self.call(None, "--dry-run"); self.assertEqual(dry.returncode, 0); self.assertFalse(final.exists())
        partial_env = self.env | {"FAKE_PARTIAL": "1"}
        partial = self.call(None, env=partial_env); self.assertEqual(partial.returncode, 1)
        complete = self.call(); self.assertEqual(complete.returncode, 0, complete.stderr); self.assertEqual(final.read_bytes(), source.read_bytes())

    def test_device_ambiguity_and_duplicate_aliases(self):
        self.snapshot(); self.track("a.mp3", "a" * 64)
        ambiguous = self.env | {"FAKE_DEVICES": "List of devices attached\na device model:Pixel_10_Pro\nb device model:Pixel_10_Pro", "FAKE_SERIAL_a": "A", "FAKE_SERIAL_b": "B"}
        result = self.call(self.profile(device=None), env=ambiguous)
        self.assertEqual(result.returncode, 2)
        self.assertIn("found 2", json.loads(result.stdout)["error"])
        same = self.env | {"FAKE_DEVICES": "List of devices attached\na device model:Pixel_10_Pro\nb device model:Pixel_10_Pro"}
        self.assertEqual(self.call(self.profile(device=None), env=same).returncode, 0)

    def test_empty_recognition_is_not_stale_and_unknown_profile_is_rejected(self):
        self.snapshot(); self.track("not funkot.mp3", "a" * 64, False)
        empty = self.call(); self.assertEqual(empty.returncode, 0, empty.stderr)
        self.assertEqual(json.loads(empty.stdout)["counts"]["recognized"], 0)
        self.assertEqual(json.loads(empty.stdout)["counts"]["copied"], 0)
        self.track("stale candidate.mp3", "b" * 64, True, version=14)
        stale = self.call(); self.assertEqual(stale.returncode, 2)
        self.assertEqual(json.loads(stale.stdout)["counts"]["stale"], 1)
        profile = self.profile(unrecognized_field=True)
        invalid = self.call(profile); self.assertEqual(invalid.returncode, 2)
        self.assertIn("unknown fields", json.loads(invalid.stdout)["error"])

    def test_unrelated_unavailable_device_and_changed_physical_identity(self):
        self.snapshot(); self.track("one.mp3", "a" * 64)
        devices = self.env | {"FAKE_DEVICES": "List of devices attached\na device model:Pixel_10_Pro\nother unauthorized"}
        result = self.call(self.profile(device=None), env=devices)
        self.assertEqual(result.returncode, 0, result.stderr)
        changed = self.call(env=self.env | {"FAKE_IDENTITY_SERIAL": "OTHER-PHYSICAL-DEVICE"})
        self.assertEqual(changed.returncode, 2)
        self.assertIn("identity changed", json.loads(changed.stdout)["error"])

    @unittest.skipUnless(shutil.which("sh"), "POSIX sh unavailable")
    def test_generated_shell_promotes_unicode_without_overwrite(self):
        class LocalAdb:
            def __init__(self, root): self.root = root; self.partial = False
            def shell(self, script):
                command = script.replace(DESTINATION, self.root.as_posix())
                return subprocess.run(["sh"], input=command.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            def call(self, *args, stdin=None):
                if args[0] != "push": raise AssertionError(args)
                target = self.root / Path(args[2]).relative_to(DESTINATION)
                target.parent.mkdir(parents=True, exist_ok=True)
                if self.partial:
                    self.partial = False
                    target.write_bytes(Path(args[1]).read_bytes()[:1])
                    return subprocess.CompletedProcess(args, 1, b"", b"interrupted")
                shutil.copyfile(args[1], target)
                return subprocess.CompletedProcess(args, 0, b"", b"")
        source = self.music / "Beyoncé" / "O'Neil song.mp3"
        source.parent.mkdir(); source.write_bytes(b"sound")
        item = ("Beyoncé/O'Neil song.mp3", source, 5, source.stat().st_mtime_ns // 1_000_000)
        self.assertEqual(TRANSFER.copy_one(LocalAdb(self.device / "Music"), DESTINATION, item, False), "copied")
        self.assertEqual((self.device / "Music" / "Beyoncé" / "O'Neil song.mp3").read_bytes(), b"sound")
        self.assertEqual(TRANSFER.copy_one(LocalAdb(self.device / "Music"), DESTINATION, item, False), "existing")
        final = self.device / "Music" / "Beyoncé" / "O'Neil song.mp3"
        final.unlink()
        temporary, _ = TRANSFER.temp_names(item[0])
        foreign = self.device / "Music" / temporary
        foreign.write_bytes(b"foreign upload")
        self.assertEqual(TRANSFER.copy_one(LocalAdb(self.device / "Music"), DESTINATION, item, False), "conflict")
        self.assertEqual(foreign.read_bytes(), b"foreign upload")
        interrupted_source = self.music / "Interrupted & resumed.mp3"
        interrupted_source.write_bytes(b"resumed sound")
        interrupted = (interrupted_source.name, interrupted_source, 13, interrupted_source.stat().st_mtime_ns // 1_000_000)
        adb = LocalAdb(self.device / "Music"); adb.partial = True
        self.assertEqual(TRANSFER.copy_one(adb, DESTINATION, interrupted, False), "failed")
        self.assertFalse((self.device / "Music" / interrupted_source.name).exists())
        self.assertEqual(TRANSFER.copy_one(adb, DESTINATION, interrupted, False), "copied")
        self.assertEqual((self.device / "Music" / interrupted_source.name).read_bytes(), b"resumed sound")


if __name__ == "__main__":
    unittest.main()

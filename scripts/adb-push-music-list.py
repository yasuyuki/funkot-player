#!/usr/bin/env python3
"""Copy recognized music to an already-created Android app Music directory.

Use --profile for private app and device settings, or provide normal options.
Use --list with --music-root for deliberate explicit-list transfer.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shlex
import subprocess
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, NamedTuple

DESTINATION = "/storage/emulated/0/Android/data/jp.hatsuboshi.funkotplayer/files/Music"
PROFILE_KEYS = {"app_dir", "adb", "device", "model", "cache_version", "music_root", "destination"}
COUNT_KEYS = ("recognized", "non_funkot", "invalid", "stale", "needs_reanalysis", "changed", "unanalyzed", "missing_source", "existing", "missing", "copied", "conflict", "failed")


class Error(Exception):
    pass


class Device(NamedTuple):
    selector: str
    serial: str
    model: str


def stop(message: str) -> None:
    raise Error(message)


def read_json(path: Path, name: str) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        stop(f"{name} cannot be read: {path}: {error}")


def relative(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or any(c in value for c in "\0\r\n"):
        stop(f"unsafe relative path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        stop(f"unsafe relative path: {value!r}")
    return value


def index_relative(indexed: str, music_dir: str) -> str:
    path_type = PureWindowsPath if ("\\" in indexed or "\\" in music_dir or (len(indexed) > 1 and indexed[1] == ":")) else PurePosixPath
    try:
        return relative(path_type(indexed).relative_to(path_type(music_dir)).as_posix())
    except ValueError:
        stop(f"hash-index path is outside configured music_dir: {indexed}")


def counts() -> dict[str, int]:
    return {key: 0 for key in COUNT_KEYS}


def app_music_dir(app: Path) -> str:
    state = app / "playback-state.json"
    if state.exists():
        data = read_json(state, "playback-state.json")
        if not isinstance(data, dict) or data.get("schema_version") != 1:
            stop("playback-state.json is corrupt or has an unsupported schema_version")
        settings = data.get("settings")
        music = settings.get("music_dir") if isinstance(settings, dict) else None
        if not isinstance(music, str) or not music:
            stop("playback-state.json has no settings.music_dir")
        return music
    data = read_json(app / "settings.json", "settings.json")
    music = data.get("music_dir") if isinstance(data, dict) else None
    if not isinstance(music, str) or not music:
        stop("settings.json has no music_dir")
    return music


def selected(app: Path, root: Path | None, version: Any) -> tuple[list[tuple[str, Path, int, int]], dict[str, int], bool]:
    if version is None:
        stop("--cache-version or profile cache_version is required for recognized mode")
    if root is not None and not root.is_dir():
        stop(f"music root is unavailable: {root}")
    music_dir, index = app_music_dir(app), read_json(app / "hash-index.json", "hash-index.json")
    if root is None and not Path(music_dir).is_dir():
        stop(f"configured music root is unavailable: {music_dir}; use --music-root for a mounted copy")
    if not isinstance(index, dict):
        stop("hash-index.json must be a JSON object")
    library_file = app / "library.json"
    library = {} if not library_file.exists() else read_json(library_file, "library.json")
    if not isinstance(library, dict):
        stop("library.json must be a JSON object")
    result, summary, unsafe = [], counts(), False
    for raw_path, record in sorted(index.items()):
        if not isinstance(raw_path, str) or not isinstance(record, dict):
            summary["invalid"] += 1; unsafe = True; continue
        try:
            rel = index_relative(raw_path, music_dir)
        except Error:
            summary["invalid"] += 1; unsafe = True; continue
        digest, length, modified = record.get("hash"), record.get("len"), record.get("mtime_ms")
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdefABCDEF" for c in digest) or not isinstance(length, int) or not isinstance(modified, int):
            summary["invalid"] += 1; unsafe = True; continue
        cache_file = app / "funkot-cache" / f"{digest}.json"
        if not cache_file.is_file():
            summary["unanalyzed"] += 1; continue
        cache = read_json(cache_file, "analysis cache")
        if not isinstance(cache, dict):
            stop(f"analysis cache is not an object: {cache_file}")
        if str(cache.get("version")) != str(version):
            summary["stale"] += 1; continue
        if cache.get("needs_reanalysis") is True:
            summary["needs_reanalysis"] += 1; continue
        verdict = cache.get("is_funkot")
        if not isinstance(verdict, bool):
            summary["unanalyzed"] += 1; continue
        override = library.get(digest)
        if override is not None and (not isinstance(override, dict) or ("funkot" in override and not isinstance(override["funkot"], bool))):
            summary["invalid"] += 1; unsafe = True; continue
        verdict = override.get("funkot", verdict) if isinstance(override, dict) else verdict
        if not verdict:
            summary["non_funkot"] += 1; continue
        source = root / rel if root else Path(raw_path)
        try:
            state = source.stat()
        except OSError:
            summary["missing_source"] += 1; continue
        if not source.is_file():
            summary["missing_source"] += 1; continue
        if state.st_size != length or state.st_mtime_ns // 1_000_000 != modified:
            summary["changed"] += 1; continue
        summary["recognized"] += 1; result.append((rel, source, state.st_size, state.st_mtime_ns // 1_000_000))
    return result, summary, unsafe


def listed(path: Path, root: Path) -> tuple[list[tuple[str, Path, int, int]], dict[str, int]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        stop(f"cannot read list file: {error}")
    result, summary, seen = [], counts(), set()
    for line in lines:
        if not line: continue
        rel = relative(line)
        if rel in seen: continue
        seen.add(rel)
        source = root / rel
        try: state = source.stat()
        except OSError: summary["missing_source"] += 1; continue
        if not source.is_file(): summary["missing_source"] += 1; continue
        summary["recognized"] += 1; result.append((rel, source, state.st_size, state.st_mtime_ns // 1_000_000))
    return result, summary


def run(command: list[str], stdin: bytes | None = None, timeout: float | None = None) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(command, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        stop(f"command failed: {' '.join(command[:3])}: {error}")


def tag(kind: str, **fields: Any) -> str:
    value = base64.b64encode(json.dumps({"kind": kind, **fields}, ensure_ascii=False).encode("utf-8")).decode("ascii")
    return f"# FUNKOT_TRANSFER {value}\n"


class Adb:
    def __init__(self, executable: str, selector: str, timeout: float | None):
        self.executable, self.selector, self.timeout = executable, selector, timeout

    def call(self, *arguments: str, stdin: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
        return run([self.executable, "-s", self.selector, *arguments], stdin, self.timeout)

    def shell(self, script: str) -> subprocess.CompletedProcess[bytes]:
        return self.call("shell", "sh", "-s", stdin=script.encode("utf-8"))


def text(value: bytes) -> str:
    return value.decode("utf-8", "replace").strip()


def shell(adb: Adb, script: str, action: str) -> bytes:
    result = adb.shell(script)
    if result.returncode:
        stop(f"{action} failed: {text(result.stderr or result.stdout)}")
    return result.stdout


def model_key(value: str) -> str:
    return " ".join(value.replace("_", " ").split()).casefold()


def adb_property(executable: str, selector: str, name: str, timeout: float | None) -> str:
    response = run([executable, "-s", selector, "shell", "getprop", name], timeout=timeout)
    if response.returncode:
        stop(f"cannot read {name} from {selector}: {text(response.stderr or response.stdout)}")
    value = text(response.stdout)
    if not value:
        stop(f"device {selector} returned no {name}")
    return value


def choose_device(executable: str, requested: str | None, model: str | None, timeout: float | None) -> Device:
    response = run([executable, "devices", "-l"], timeout=timeout)
    if response.returncode:
        stop("adb devices -l failed: " + text(response.stderr or response.stdout))
    devices = []
    for line in text(response.stdout).splitlines():
        fields = line.split()
        if len(fields) < 2 or fields[0] == "List": continue
        properties = dict(field.split(":", 1) for field in fields[2:] if ":" in field)
        devices.append((fields[0], fields[1], properties.get("model", "")))
    bad = [item for item in devices if item[1] != "device"]
    if any(requested == item[0] for item in bad):
        stop("selected device is unavailable or unauthorized")
    exact_selector = any(requested == item[0] for item in devices)
    physical: dict[str, Device] = {}
    for selector, state, advertised_model in devices:
        if state != "device": continue
        if exact_selector and requested != selector: continue
        if model is not None and advertised_model and model_key(advertised_model) != model_key(model): continue
        serial = adb_property(executable, selector, "ro.serialno", timeout)
        actual_model = adb_property(executable, selector, "ro.product.model", timeout)
        if requested is not None and requested not in (selector, serial): continue
        if model is not None and model_key(model) != model_key(actual_model): continue
        physical.setdefault(serial, Device(selector, serial, actual_model))
    if not physical and bad:
        stop("no connected target matched; unavailable or unauthorized devices are present")
    if len(physical) != 1:
        stop(f"require exactly one intended physical device, found {len(physical)}")
    return next(iter(physical.values()))


def destination(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("/") or any(char in value for char in "\0\r\n"):
        stop("destination must be an absolute safe Android path")
    return value.rstrip("/")


def preflight(adb: Adb, dest: str, device: Device) -> dict[str, int]:
    identity = text(shell(adb, tag("identity") + "getprop ro.serialno; getprop ro.product.model\n", "device identity")).splitlines()
    if not identity or identity[0] != device.serial: stop("device identity changed before transfer")
    if len(identity) < 2 or model_key(identity[1]) != model_key(device.model): stop("selected device model changed before transfer")
    quoted = shlex.quote(dest)
    script = tag("preflight", destination=dest) + f"test -d {quoted} && test ! -L {quoted} || exit 31\nfind {quoted} -type l -print -quit | grep -q . && exit 32 || true\n"
    shell(adb, script, "destination preflight")
    # NUL-delimited fields keep names with whitespace and shell metacharacters intact.
    data = shell(adb, tag("inventory", destination=dest) + f"find {quoted} -type f -exec sh -c 'root=$1; shift; for p do r=${{p#\"$root\"/}}; printf \"%s\\0%s\\0\" \"$r\" \"$(stat -c %s \"$p\")\"; done' sh {quoted} {{}} +\n", "destination inventory")
    fields = data.split(b"\0")
    if fields and fields[-1] == b"": fields.pop()
    if len(fields) % 2: stop("destination inventory is malformed")
    result = {}
    for name, size in zip(fields[::2], fields[1::2]):
        result[relative(name.decode("utf-8", "strict"))] = int(size)
    return result


def temp_names(rel: str) -> tuple[str, str]:
    digest = hashlib.sha256(rel.encode("utf-8")).hexdigest()
    parent = str(PurePosixPath(rel).parent)
    prefix = "" if parent == "." else parent + "/"
    temp = prefix + f".funkot-transfer-{digest}.part"
    return temp, temp + ".owner"


def inspect(adb: Adb, dest: str, rel: str) -> tuple[str, int | None]:
    path = f"{dest}/{rel}"
    quoted = shlex.quote(path)
    script = (f"if [ -L {quoted} ] || [ -d {quoted} ] || {{ [ -e {quoted} ] && [ ! -f {quoted} ]; }}; then "
              "printf 'other\\t-\\n'; elif [ -f " + quoted + " ]; then printf 'file\\t'; stat -c %s " + quoted + "; else printf 'missing\\t-\\n'; fi\n")
    output = text(shell(adb, tag("inspect", destination=dest, relative=rel) + script, "remote path inspection"))
    fields = output.split("\t")
    if len(fields) != 2 or fields[0] not in {"missing", "file", "other"}: stop("remote path inspection returned malformed data")
    return fields[0], int(fields[1]) if fields[1].isdigit() else None


def copy_one(adb: Adb, dest: str, item: tuple[str, Path, int, int], dry_run: bool) -> str:
    rel, source, size, modified = item
    kind, remote_size = inspect(adb, dest, rel)
    if kind == "file": return "existing" if remote_size == size else "conflict"
    if kind != "missing": return "conflict"
    if dry_run: return "missing"
    if not source.is_file() or source.stat().st_size != size or source.stat().st_mtime_ns // 1_000_000 != modified: return "changed"
    temp, owner = temp_names(rel)
    stamp = base64.b64encode(json.dumps({"relative": rel, "size": size, "mtime_ms": modified}, ensure_ascii=False).encode()).decode()
    final_path, temp_path, owner_path = f"{dest}/{rel}", f"{dest}/{temp}", f"{dest}/{owner}"
    parent = str(PurePosixPath(final_path).parent)
    script = (
        f"if [ -e {shlex.quote(final_path)} ] || [ -L {shlex.quote(final_path)} ]; then echo CONFLICT; "
        f"elif ! mkdir -p {shlex.quote(parent)} || [ -L {shlex.quote(parent)} ]; then exit 33; "
        f"elif [ -e {shlex.quote(temp_path)} ] || [ -L {shlex.quote(temp_path)} ]; then "
        f"[ -f {shlex.quote(temp_path)} ] && [ ! -L {shlex.quote(temp_path)} ] && [ -f {shlex.quote(owner_path)} ] && [ ! -L {shlex.quote(owner_path)} ] && [ \"$(cat {shlex.quote(owner_path)})\" = {shlex.quote(stamp)} ] && echo READY || echo CONFLICT; "
        f"elif [ -e {shlex.quote(owner_path)} ] || [ -L {shlex.quote(owner_path)} ]; then "
        f"[ -f {shlex.quote(owner_path)} ] && [ ! -L {shlex.quote(owner_path)} ] && [ \"$(cat {shlex.quote(owner_path)})\" = {shlex.quote(stamp)} ] && echo READY || echo CONFLICT; "
        f"else printf %s {shlex.quote(stamp)} > {shlex.quote(owner_path)} && echo READY; fi\n"
    )
    ready = text(shell(adb, tag("prepare", destination=dest, relative=rel, temp=temp, owner=owner, stamp=stamp) + script, "temporary upload preparation"))
    if ready != "READY": return "conflict"
    pushed = adb.call("push", str(source), f"{dest}/{temp}")
    if pushed.returncode: return "failed"
    kind, remote_size = inspect(adb, dest, temp)
    if kind != "file" or remote_size != size: return "failed"
    if not source.is_file() or source.stat().st_size != size or source.stat().st_mtime_ns // 1_000_000 != modified: return "changed"
    script = (
        f"if [ -e {shlex.quote(final_path)} ] || [ -L {shlex.quote(final_path)} ] || ! [ -f {shlex.quote(temp_path)} ] || [ -L {shlex.quote(temp_path)} ] || "
        f"[ \"$(stat -c %s {shlex.quote(temp_path)})\" != {size} ] || ! [ -f {shlex.quote(owner_path)} ] || [ -L {shlex.quote(owner_path)} ] || "
        f"[ \"$(cat {shlex.quote(owner_path)})\" != {shlex.quote(stamp)} ]; then echo CONFLICT; "
        f"elif mv -n {shlex.quote(temp_path)} {shlex.quote(final_path)} && [ -f {shlex.quote(final_path)} ] && "
        f"[ \"$(stat -c %s {shlex.quote(final_path)})\" = {size} ] && ! [ -e {shlex.quote(temp_path)} ]; then rm -f {shlex.quote(owner_path)}; echo COPIED; else echo CONFLICT; fi\n"
    )
    promoted = text(shell(adb, tag("promote", destination=dest, relative=rel, temp=temp, owner=owner, stamp=stamp, size=size) + script, "no-overwrite promotion"))
    if promoted != "COPIED": return "conflict"
    kind, remote_size = inspect(adb, dest, rel)
    temp_kind, _ = inspect(adb, dest, temp)
    return "copied" if kind == "file" and remote_size == size and temp_kind == "missing" else "failed"


def parse() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, help="private JSON settings: " + ", ".join(sorted(PROFILE_KEYS)))
    parser.add_argument("--app-dir", help="actual data directory of the app that produced the saved recognition")
    parser.add_argument("--adb", help="adb executable path, or adb from PATH")
    parser.add_argument("--device", help="existing adb selector or physical hardware serial")
    parser.add_argument("--model", help="intended device model; underscores and spaces are equivalent")
    parser.add_argument("--cache-version", type=int, help="required saved analysis version used by the producing app")
    parser.add_argument("--music-root", help="optional local mount of the app's configured music directory")
    parser.add_argument("--destination", help="existing app-created Android Music directory")
    parser.add_argument("--list", type=Path, dest="list_path", help="explicit relative-path list")
    parser.add_argument("--result", type=Path, help="write the final private JSON summary")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--timeout", type=float)
    return parser


def profile(path: Path | None) -> dict[str, Any]:
    if path is None: return {}
    value = read_json(path, "profile")
    if not isinstance(value, dict): stop("profile must be a JSON object")
    unknown = sorted(set(value) - PROFILE_KEYS)
    if unknown: stop("profile has unknown fields: " + ", ".join(unknown))
    return value


def setting(args: argparse.Namespace, data: dict[str, Any], name: str, default: Any = None) -> Any:
    value = getattr(args, name)
    return value if value is not None else data.get(name, default)


def main(argv: list[str] | None = None) -> int:
    args = parse().parse_args(argv)
    summary = counts()
    try:
        config = profile(args.profile)
        adb_path = setting(args, config, "adb", "adb")
        if not isinstance(adb_path, str) or not adb_path: stop("adb must be a non-empty executable path")
        if args.timeout is not None and args.timeout <= 0: stop("--timeout must be positive")
        root_value = setting(args, config, "music_root")
        root = Path(root_value) if isinstance(root_value, str) else None
        if args.list_path:
            if root is None: stop("--music-root or profile music_root is required with --list")
            if not root.is_dir(): stop(f"music root is unavailable: {root}")
            print("selecting explicit list", file=sys.stderr, flush=True)
            plan, summary, unsafe = *listed(args.list_path, root), False
        else:
            app_value = setting(args, config, "app_dir")
            if not isinstance(app_value, str) or not app_value: stop("--app-dir or profile app_dir is required for recognized mode")
            print("selecting recognized tracks", file=sys.stderr, flush=True)
            plan, summary, unsafe = selected(Path(app_value), root, setting(args, config, "cache_version"))
        if unsafe: stop("input contains invalid entries; no device writes were attempted")
        if not args.list_path and not plan and any(summary[key] for key in ("stale", "unanalyzed", "needs_reanalysis")):
            stop("no current recognized analyses remain; stale and unanalyzed entries were excluded")
        target = destination(setting(args, config, "destination", DESTINATION))
        print("checking device and destination inventory", file=sys.stderr, flush=True)
        device = choose_device(adb_path, setting(args, config, "device"), setting(args, config, "model"), args.timeout)
        adb = Adb(adb_path, device.selector, args.timeout)
        inventory = preflight(adb, target, device)
        for item in plan:
            rel, _, size, _ = item
            if rel in inventory:
                summary["existing" if inventory[rel] == size else "conflict"] += 1
                continue
            print(f"transfer {rel}", file=sys.stderr, flush=True)
            summary[copy_one(adb, target, item, args.dry_run)] += 1
        failed = sum(summary[key] for key in ("invalid", "changed", "missing_source", "conflict", "failed"))
        output: dict[str, Any] = {"counts": summary, "destination": target, "device": device.selector, "dry_run": args.dry_run}
        if args.result: args.result.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(output, ensure_ascii=False, sort_keys=True))
        return 1 if failed else 0
    except Error as error:
        print(f"error: {error}", file=sys.stderr)
        output = {"counts": summary, "error": str(error), "dry_run": args.dry_run}
        if args.result:
            args.result.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(output, ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

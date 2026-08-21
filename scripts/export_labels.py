#!/usr/bin/env python3
"""Export human Funkot labels as one-path-per-line playlists (phase-06).

Reads AppData `labels.json` + `hash-index.json` and writes
`classify_funkot.txt` / `classify_not_funkot.txt` under funkot-autodj-for-ui
testdata, using WSL absolute paths (`/mnt/oldpc/music/<rel>`).

Usage:
  python3 scripts/export_labels.py --self-test
  python3 scripts/export_labels.py --app-dir DIR [--out-dir DIR]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from glob import glob
from pathlib import Path
from typing import Any

LABELS_FILE = "labels.json"
HASH_INDEX_FILE = "hash-index.json"
SETTINGS_FILE = "settings.json"
WSL_MUSIC_ROOT = "/mnt/oldpc/music"


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def resolve_app_dir(explicit: str | None) -> Path:
    raw = explicit if explicit is not None else os.environ.get("FUNKOT_APP_DIR")
    if raw:
        return Path(raw)
    matches: list[Path] = []
    for pat in (
        "/mnt/c/Users/*/AppData/Roaming/jp.hatsuboshi.funkotplayer",
        "/c/Users/*/AppData/Roaming/jp.hatsuboshi.funkotplayer",
    ):
        matches.extend(Path(p) for p in glob(pat) if Path(p, "funkot-cache").is_dir())
    if len(matches) == 1:
        return matches[0]
    if not matches:
        die("--app-dir か環境変数 FUNKOT_APP_DIR が必要です")
    die("app-dir が複数あります。--app-dir で指定してください:\n" + "\n".join(str(p) for p in matches))


def resolve_workspace_root() -> Path:
    here = Path(__file__).resolve().parent
    cur = here
    while cur != cur.parent:
        if (cur / "funkot-player").is_dir() and (cur / "funkot-autodj-for-ui").is_dir():
            return cur
        cur = cur.parent
    die("workspace root が見つからない（funkot-player と funkot-autodj-for-ui が兄弟である必要）")


def load_music_dir(app_dir: Path) -> str | None:
    settings_path = app_dir / SETTINGS_FILE
    if not settings_path.is_file():
        return None
    data = load_json(settings_path)
    if not isinstance(data, dict):
        return None
    md = data.get("music_dir")
    if md is None or md == "":
        return None
    return str(md)


def rel_path_for(abs_path: str, music_dir: str | None) -> str:
    """Strip music_dir prefix; separators become '/'."""
    if music_dir is not None:
        prefix = music_dir.rstrip("\\/")
        if abs_path.startswith(prefix):
            rest = abs_path[len(prefix) :].lstrip("/\\")
            return rest.replace("\\", "/")
    return abs_path.replace("\\", "/")


def wsl_path_for(abs_path: str, music_dir: str | None) -> str:
    if music_dir is None:
        die("music_dir が無い")
    prefix = music_dir.rstrip("\\/")
    if not abs_path.replace("/", "\\").lower().startswith(prefix.replace("/", "\\").lower()):
        die(f"path が music_dir で始まらない: {abs_path}")
    rel = rel_path_for(abs_path, music_dir)
    return f"{WSL_MUSIC_ROOT}/{rel}"


def hash_of(entry: Any) -> str:
    if isinstance(entry, dict):
        h = entry.get("hash")
        if isinstance(h, str) and h:
            return h
        die("hash-index のエントリに hash が無い")
    die("hash-index の値がオブジェクトではない")


def export(app_dir: Path, out_dir: Path) -> None:
    labels_path = app_dir / LABELS_FILE
    index_path = app_dir / HASH_INDEX_FILE
    if not labels_path.is_file():
        die(f"labels.json が無い: {labels_path}")
    if not index_path.is_file():
        die(f"hash-index.json が無い: {index_path}")

    labels = load_json(labels_path)
    index = load_json(index_path)
    if not isinstance(labels, dict):
        die("labels.json がオブジェクトではない")
    if not isinstance(index, dict):
        die("hash-index.json がオブジェクトではない")

    music_dir = load_music_dir(app_dir)
    if music_dir is None:
        die("settings.json に music_dir が無い")
    by_hash: dict[str, str] = {}
    for unc, rec in index.items():
        h = hash_of(rec)
        if h in by_hash:
            die(f"hash-index に重複ハッシュ: {h}")
        by_hash[h] = str(unc)

    funkot: list[str] = []
    not_funkot: list[str] = []
    unlabeled: list[tuple[str, str]] = []
    missing_index: list[str] = []

    for h, rec in labels.items():
        if not isinstance(rec, dict) or "verdict" not in rec:
            die(f"labels.json の {h} が TrackLabel ではない")
        unc = by_hash.get(h)
        if unc is None:
            missing_index.append(h)
            continue
        wsl = wsl_path_for(unc, music_dir)
        if rec.get("verdict") is True:
            funkot.append(wsl)
        elif rec.get("verdict") is False:
            not_funkot.append(wsl)
        else:
            die(f"labels.json の {h} の verdict が bool ではない")

    for h, unc in by_hash.items():
        if h not in labels:
            unlabeled.append((h, wsl_path_for(unc, music_dir)))

    funkot.sort()
    not_funkot.sort()

    out_dir.mkdir(parents=True, exist_ok=True)
    funkot_path = out_dir / "classify_funkot.txt"
    not_path = out_dir / "classify_not_funkot.txt"
    funkot_path.write_text("".join(p + "\n" for p in funkot), encoding="utf-8")
    not_path.write_text("".join(p + "\n" for p in not_funkot), encoding="utf-8")

    print(f"wrote {funkot_path} ({len(funkot)})")
    print(f"wrote {not_path} ({len(not_funkot)})")
    print(f"unlabeled {len(unlabeled)}")
    for h, p in unlabeled:
        print(f"  UNLABELED {h} {p}")
    if missing_index:
        print(f"label without hash-index {len(missing_index)}", file=sys.stderr)
        for h in missing_index:
            print(f"  ORPHAN {h}", file=sys.stderr)
        raise SystemExit(1)


def self_test() -> None:
    md = r"\\LAPTOP-QM7J9GBE\music"
    unc = r"\\LAPTOP-QM7J9GBE\music\Foo Bar\01. Track.m4a"
    assert rel_path_for(unc, md) == "Foo Bar/01. Track.m4a"
    assert wsl_path_for(unc, md) == "/mnt/oldpc/music/Foo Bar/01. Track.m4a"
    print("self-test ok")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--app-dir", default=None)
    ap.add_argument(
        "--out-dir",
        default=None,
        help="default: <workspace>/funkot-autodj-for-ui/testdata",
    )
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return
    app_dir = resolve_app_dir(args.app_dir)
    out_dir = (
        Path(args.out_dir)
        if args.out_dir
        else resolve_workspace_root() / "funkot-autodj-for-ui" / "testdata"
    )
    export(app_dir, out_dir)


if __name__ == "__main__":
    main()

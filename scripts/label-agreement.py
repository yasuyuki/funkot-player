#!/usr/bin/env python3
"""Self-agreement harness for human labeling (phase-05d).

Measures agreement rate and Cohen's κ when a person labels the same sample twice.

Usage:
  python3 scripts/label-agreement.py --self-test
  python3 scripts/label-agreement.py sample --app-dir DIR --seed N --count 30 --out FILE
  python3 scripts/label-agreement.py snapshot --app-dir DIR --out FILE
  python3 scripts/label-agreement.py clear --app-dir DIR --sample FILE [--yes]
  python3 scripts/label-agreement.py agreement --a FILE --b FILE --sample FILE
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

LABELS_FILE = "labels.json"
HASH_INDEX_FILE = "hash-index.json"
SETTINGS_FILE = "settings.json"


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def resolve_app_dir(explicit: str | None) -> Path:
    raw = explicit if explicit is not None else os.environ.get("FUNKOT_APP_DIR")
    if not raw:
        die("--app-dir か環境変数 FUNKOT_APP_DIR が必要です")
    return Path(raw)


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_labels(path: Path, labels: dict[str, Any]) -> None:
    ordered = dict(sorted(labels.items()))
    with path.open("w", encoding="utf-8") as f:
        json.dump(ordered, f, indent=2, ensure_ascii=False)
        f.write("\n")


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
    """Build display rel_path (same prefix strip as app relName when prefix matches)."""
    if music_dir is not None and abs_path.startswith(music_dir):
        rest = abs_path[len(music_dir) :].lstrip("/\\")
        return rest.replace("\\", "/")
    return abs_path.replace("\\", "/")


def backup_labels(app_dir: Path) -> Path:
    src = app_dir / LABELS_FILE
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = app_dir / f"labels.json.bak-{stamp}"
    n = 1
    while dest.exists():
        n += 1
        dest = app_dir / f"labels.json.bak-{stamp}-{n}"
    shutil.copy2(src, dest)
    return dest


def read_sample_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        if reader.fieldnames is None:
            die(f"空の sample TSV です: {path}")
        rows = list(reader)
    return rows


def cmd_sample(app_dir: Path, seed: int, count: int, out: Path) -> None:
    index_path = app_dir / HASH_INDEX_FILE
    if not index_path.is_file():
        die(f"{HASH_INDEX_FILE} がありません: {index_path}")
    index = load_json(index_path)
    if not isinstance(index, dict):
        die(f"{HASH_INDEX_FILE} の形式が不正です")

    population = sorted(index.keys())
    if count > len(population):
        die(f"--count {count} が母集団 {len(population)} 件を超えています")

    chosen = random.Random(int(seed)).sample(population, count)
    chosen_sorted = sorted(chosen)
    music_dir = load_music_dir(app_dir)

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", lineterminator="\n")
        writer.writerow(["hash", "rel_path", "title", "artist"])
        for abs_path in chosen_sorted:
            entry = index[abs_path]
            if not isinstance(entry, dict):
                die(f"hash-index エントリが不正です: {abs_path}")
            h = entry.get("hash", "")
            title = entry.get("title")
            artist = entry.get("artist")
            writer.writerow(
                [
                    "" if h is None else str(h),
                    rel_path_for(abs_path, music_dir),
                    "" if title is None else str(title),
                    "" if artist is None else str(artist),
                ]
            )


def cmd_snapshot(app_dir: Path, out: Path) -> None:
    labels_path = app_dir / LABELS_FILE
    if not labels_path.is_file():
        die(f"{LABELS_FILE} がありません: {labels_path}")
    backup_labels(app_dir)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(labels_path, out)


def cmd_clear(app_dir: Path, sample: Path, *, assume_yes: bool) -> None:
    if not assume_yes:
        prompt = (
            "labels.json を書き換えます。アプリが起動中だと終了時に上書きされます。"
            "アプリを終了したなら yes と入力してください:"
        )
        print(prompt, file=sys.stderr, end="")
        answer = sys.stdin.readline()
        if answer.strip() != "yes":
            die("中止しました（yes 以外が入力されました）")

    labels_path = app_dir / LABELS_FILE
    if not labels_path.is_file():
        die(f"{LABELS_FILE} がありません: {labels_path}")

    rows = read_sample_rows(sample)
    sample_hashes = {row["hash"] for row in rows if row.get("hash")}

    backup_labels(app_dir)
    labels = load_json(labels_path)
    if not isinstance(labels, dict):
        die(f"{LABELS_FILE} の形式が不正です")

    for h in sample_hashes:
        labels.pop(h, None)

    save_labels(labels_path, labels)


def agreement_stats(
    labels_a: dict[str, Any],
    labels_b: dict[str, Any],
    sample_rows: list[dict[str, str]],
) -> tuple[int, int, float | None, int, list[tuple[str, bool, bool]]]:
    """Return (n, agree_count, kappa_or_None, one_sided, mismatches)."""
    both_true = both_false = a_true_b_false = a_false_b_true = 0
    one_sided = 0
    mismatches: list[tuple[str, bool, bool]] = []

    for row in sample_rows:
        h = row["hash"]
        rel = row.get("rel_path", "")
        in_a = h in labels_a
        in_b = h in labels_b
        if not (in_a and in_b):
            one_sided += 1
            continue
        va = bool(labels_a[h]["verdict"])
        vb = bool(labels_b[h]["verdict"])
        if va and vb:
            both_true += 1
        elif va and not vb:
            a_true_b_false += 1
            mismatches.append((rel, va, vb))
        elif not va and vb:
            a_false_b_true += 1
            mismatches.append((rel, va, vb))
        else:
            both_false += 1

    n = both_true + both_false + a_true_b_false + a_false_b_true
    agree = both_true + both_false

    if n == 0:
        return n, agree, None, one_sided, mismatches

    p_o = (both_true + both_false) / n
    p_yes_a = (both_true + a_true_b_false) / n
    p_yes_b = (both_true + a_false_b_true) / n
    p_no_a = (a_false_b_true + both_false) / n
    p_no_b = (a_true_b_false + both_false) / n
    p_e = p_yes_a * p_yes_b + p_no_a * p_no_b
    denom = 1.0 - p_e
    kappa: float | None
    if denom == 0.0:
        kappa = None
    else:
        kappa = (p_o - p_e) / denom

    return n, agree, kappa, one_sided, mismatches


def format_agreement(
    n: int,
    agree: int,
    kappa: float | None,
    one_sided: int,
    mismatches: list[tuple[str, bool, bool]],
) -> str:
    if n == 0:
        rate_s = f"{agree}/{n} = 母数 0"
        kappa_s = "undefined"
    else:
        rate_s = f"{agree}/{n} = {agree / n:.4f}"
        kappa_s = "undefined" if kappa is None else f"{kappa:.4f}"

    lines = [
        f"labeled_both: {n}",
        f"agreement: {rate_s}",
        f"kappa: {kappa_s}",
        f"one_sided: {one_sided}",
    ]
    if n == 0:
        lines.append("（母数 0 — 両方にラベルがある曲がありません）")
    if one_sided:
        lines.append(
            f"（one_sided {one_sided} 件は片方のみまたは両方未ラベルのため母数から除外）"
        )
    if mismatches:
        lines.append("mismatches:")
        for rel, va, vb in mismatches:
            lines.append(f"  {rel}\ta={json.dumps(va)}\tb={json.dumps(vb)}")
    return "\n".join(lines) + "\n"


def cmd_agreement(a_path: Path, b_path: Path, sample: Path) -> None:
    labels_a = load_json(a_path)
    labels_b = load_json(b_path)
    if not isinstance(labels_a, dict) or not isinstance(labels_b, dict):
        die("pass ファイルの形式が不正です（labels.json と同スキーマのオブジェクトが必要）")
    rows = read_sample_rows(sample)
    n, agree, kappa, one_sided, mismatches = agreement_stats(labels_a, labels_b, rows)
    sys.stdout.write(format_agreement(n, agree, kappa, one_sided, mismatches))


def _label(verdict: bool, ms: int = 1) -> dict[str, Any]:
    return {"verdict": verdict, "labeled_at_ms": ms}


def run_self_test() -> None:
    # --- (1) + (6) agreement / kappa / one_sided ---
    sample_rows: list[dict[str, str]] = []
    labels_a: dict[str, Any] = {}
    labels_b: dict[str, Any] = {}

    # both true: 4
    for i in range(4):
        h = f"h_tt_{i}"
        sample_rows.append({"hash": h, "rel_path": f"tt/{i}.m4a"})
        labels_a[h] = _label(True)
        labels_b[h] = _label(True)
    # A true B false: 1
    h = "h_tf_0"
    sample_rows.append({"hash": h, "rel_path": "tf/0.m4a"})
    labels_a[h] = _label(True)
    labels_b[h] = _label(False)
    # A false B true: 2
    for i in range(2):
        h = f"h_ft_{i}"
        sample_rows.append({"hash": h, "rel_path": f"ft/{i}.m4a"})
        labels_a[h] = _label(False)
        labels_b[h] = _label(True)
    # both false: 3
    for i in range(3):
        h = f"h_ff_{i}"
        sample_rows.append({"hash": h, "rel_path": f"ff/{i}.m4a"})
        labels_a[h] = _label(False)
        labels_b[h] = _label(False)
    # A only: 2
    for i in range(2):
        h = f"h_aonly_{i}"
        sample_rows.append({"hash": h, "rel_path": f"aonly/{i}.m4a"})
        labels_a[h] = _label(True)
    # B only: 1
    h = "h_bonly_0"
    sample_rows.append({"hash": h, "rel_path": "bonly/0.m4a"})
    labels_b[h] = _label(False)

    n, agree, kappa, one_sided, _mismatches = agreement_stats(
        labels_a, labels_b, sample_rows
    )
    assert n == 10, f"labeled_both expected 10, got {n}"
    assert agree == 7, f"agree expected 7, got {agree}"
    assert one_sided == 3, f"one_sided expected 3, got {one_sided}"
    assert kappa is not None
    assert abs(kappa - 0.4) < 1e-9, f"kappa expected 0.4, got {kappa}"
    assert abs(agree / n - 0.7) < 1e-9

    with tempfile.TemporaryDirectory() as tmp:
        app_dir = Path(tmp)
        music_dir = r"\\HOST\music"

        # Synthetic hash-index: paths intentionally not in extraction order
        paths = [
            rf"{music_dir}\z_last\track.m4a",
            rf"{music_dir}\a_first\track.m4a",
            rf"{music_dir}\m_mid\track.m4a",
            rf"{music_dir}\b_second\track.m4a",
            rf"{music_dir}\c_third\track.m4a",
            rf"{music_dir}\d_fourth\track.m4a",
        ]
        index: dict[str, Any] = {}
        for i, p in enumerate(paths):
            index[p] = {
                "mtime_ms": 0,
                "len": 1,
                "hash": f"hash{i:02d}",
                "tags_cached": True,
                "title": f"Title {i}",
                "artist": f"Artist {i}",
            }
        (app_dir / HASH_INDEX_FILE).write_text(
            json.dumps(index, ensure_ascii=False), encoding="utf-8"
        )
        (app_dir / SETTINGS_FILE).write_text(
            json.dumps({"music_dir": music_dir}, ensure_ascii=False),
            encoding="utf-8",
        )

        # --- (2) sample determinism ---
        out1 = app_dir / "s1.tsv"
        out2 = app_dir / "s2.tsv"
        cmd_sample(app_dir, seed=42, count=4, out=out1)
        cmd_sample(app_dir, seed=42, count=4, out=out2)
        assert out1.read_bytes() == out2.read_bytes(), "sample TSV not deterministic"

        # --- (3) sample order is absolute-path sort ---
        # seed that yields a scrambled subset; output must still be path-sorted
        cmd_sample(app_dir, seed=7, count=4, out=out1)
        lines = out1.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 5, f"expected header+4, got {len(lines)} lines"
        body = list(csv.DictReader(lines, delimiter="\t"))
        # Reconstruct abs paths from rel_path + music_dir and check sort
        abs_from_rel = []
        for row in body:
            # reverse of rel_path_for under music_dir prefix
            abs_from_rel.append(music_dir + "\\" + row["rel_path"].replace("/", "\\"))
        assert abs_from_rel == sorted(abs_from_rel), "sample rows not path-sorted"
        # Also: rel_path string sort matches (spec acceptance)
        rels = [row["rel_path"] for row in body]
        assert rels == sorted(rels), "rel_path not sorted"

        # --- (4) clear keeps out-of-sample ---
        in_h1, in_h2 = "hash_in_1", "hash_in_2"
        out_h1, out_h2 = "hash_out_1", "hash_out_2"
        labels = {
            in_h1: _label(True, 10),
            in_h2: _label(False, 20),
            out_h1: _label(True, 30),
            out_h2: _label(False, 40),
        }
        save_labels(app_dir / LABELS_FILE, labels)
        sample_path = app_dir / "sample.tsv"
        with sample_path.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter="\t", lineterminator="\n")
            w.writerow(["hash", "rel_path", "title", "artist"])
            w.writerow([in_h1, "in/1.m4a", "", ""])
            w.writerow([in_h2, "in/2.m4a", "", ""])

        cmd_clear(app_dir, sample_path, assume_yes=True)
        cleared = load_json(app_dir / LABELS_FILE)
        assert in_h1 not in cleared and in_h2 not in cleared
        assert out_h1 in cleared and out_h2 in cleared
        assert cleared[out_h1] == labels[out_h1]
        assert cleared[out_h2] == labels[out_h2]

        bak_after_clear = list(app_dir.glob("labels.json.bak-*"))
        assert bak_after_clear, "clear did not leave a backup"

        # --- (5) snapshot backup + identical --out ---
        # Immediate snapshot (same-second bak name must not collide).
        save_labels(app_dir / LABELS_FILE, {out_h1: _label(True, 99)})
        snap_out = app_dir / "pass-1.json"
        before = (app_dir / LABELS_FILE).read_bytes()
        cmd_snapshot(app_dir, snap_out)
        assert snap_out.read_bytes() == before
        bak_all = list(app_dir.glob("labels.json.bak-*"))
        assert len(bak_all) >= 2, "snapshot did not leave an additional backup"

        # Human path is snapshot then clear, often in the same second.
        cmd_clear(app_dir, sample_path, assume_yes=True)
        bak_after_snap_clear = list(app_dir.glob("labels.json.bak-*"))
        assert len(bak_after_snap_clear) >= 3, "same-second snapshot+clear bak collision"

    print("self-test ok")
    print("hand calc: labeled_both=10 agreement=7/10=0.7000 kappa=0.4000 one_sided=3")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Self-agreement harness for labeling")
    p.add_argument(
        "--self-test",
        action="store_true",
        help="Run synthetic self-tests (no real AppData)",
    )
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("sample", help="Deterministic sample from hash-index.json")
    s.add_argument("--app-dir", default=None)
    s.add_argument("--seed", type=int, required=True)
    s.add_argument("--count", type=int, required=True)
    s.add_argument("--out", type=Path, required=True)

    s = sub.add_parser("snapshot", help="Copy labels.json to --out (with backup)")
    s.add_argument("--app-dir", default=None)
    s.add_argument("--out", type=Path, required=True)

    s = sub.add_parser("clear", help="Remove sample hashes from labels.json")
    s.add_argument("--app-dir", default=None)
    s.add_argument("--sample", type=Path, required=True)
    s.add_argument("--yes", action="store_true", help="Skip confirmation prompt")

    s = sub.add_parser("agreement", help="Compute agreement rate and Cohen's κ")
    s.add_argument("--a", type=Path, required=True)
    s.add_argument("--b", type=Path, required=True)
    s.add_argument("--sample", type=Path, required=True)

    return p


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.self_test:
        run_self_test()
        return

    if args.cmd is None:
        parser.error("サブコマンドか --self-test が必要です")

    if args.cmd == "sample":
        cmd_sample(resolve_app_dir(args.app_dir), args.seed, args.count, args.out)
    elif args.cmd == "snapshot":
        cmd_snapshot(resolve_app_dir(args.app_dir), args.out)
    elif args.cmd == "clear":
        cmd_clear(resolve_app_dir(args.app_dir), args.sample, assume_yes=args.yes)
    elif args.cmd == "agreement":
        cmd_agreement(args.a, args.b, args.sample)
    else:
        parser.error(f"未知のサブコマンド: {args.cmd}")


if __name__ == "__main__":
    main()

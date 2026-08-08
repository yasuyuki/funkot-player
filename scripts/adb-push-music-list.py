#!/usr/bin/env python3
"""Push relative paths under /music to the app Music dir via adb.

Usage (inside funkot-player-dev with mounts described in docs/adb-music-transfer.md):
  python3 /work/funkot-player/scripts/adb-push-music-list.py <adb-addr> [list-file]

Default list: /work/funkot-player/testdata/funkot-rel-paths.txt
Log:          /work/funkot-player/testdata/funkot-transfer.log
Same-size remote files are skipped (resume-safe).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ADDR = sys.argv[1]
LIST = Path(
    sys.argv[2]
    if len(sys.argv) > 2
    else "/work/funkot-player/testdata/funkot-rel-paths.txt"
)
DEST = "/storage/emulated/0/Android/data/jp.hatsuboshi.funkotplayer/files/Music"
ROOT = Path("/music")
LOG = Path("/work/funkot-player/testdata/funkot-transfer.log")


def sh(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True)


def adb(*args: str) -> subprocess.CompletedProcess[str]:
    return sh("adb", "-s", ADDR, *args)


LOG.write_text("")


def log(msg: str) -> None:
    print(msg, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(msg + "\n")


sh("adb", "connect", ADDR)
adb("shell", "mkdir", "-p", DEST)
rels = [ln for ln in LIST.read_text(encoding="utf-8").splitlines() if ln]
ok = fail = skip = 0
total = len(rels)

for n, rel in enumerate(rels, 1):
    src = ROOT / rel
    dest = f"{DEST}/{rel}"
    if not src.is_file():
        fail += 1
        log(f"[{n}/{total}] MISSING {rel}")
        continue
    adb("shell", "mkdir", "-p", str(Path(dest).parent))
    local_sz = src.stat().st_size
    st = adb("shell", "stat", "-c%s", dest)
    remote_sz = (st.stdout or "").strip().replace("\r", "")
    if remote_sz.isdigit() and int(remote_sz) == local_sz:
        skip += 1
        log(f"[{n}/{total}] SKIP {rel}")
        continue
    p = adb("push", str(src), dest)
    if p.returncode == 0:
        ok += 1
        log(f"[{n}/{total}] OK ({local_sz}B) {rel}")
    else:
        fail += 1
        err = (p.stderr or p.stdout or "").strip().replace("\n", " | ")
        log(f"[{n}/{total}] FAIL {rel} :: {err}")

log(f"DONE ok={ok} fail={fail} skip={skip} total={total}")
sys.exit(0 if fail == 0 else 1)

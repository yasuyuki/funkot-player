# adb で Music フォルダへ曲を一括転送

WSL から wireless adb で、ホスト上の音源ツリーを端末のアプリ Music へ
push する手順。2026-08-08 に Windows の `is_funkot=true` **412曲 / ~26.5GB** を
release 端末へ転送して成功した方法。

USB MTP や共有シートでの少数コピーは [README.md](../README.md) の
「Or copy over USB」を使う。こちらは大量・再実行可能・途中再開向け。

---

## 前提

| 項目 | 成功時の例 |
|---|---|
| 端末 | release 役の端末（`adb-device --model release` で分かる） |
| adb | `adb-device release` が返すセレクタ |
| 音源ルート（WSL） | `/mnt/oldpc/music`（UNC `\\LAPTOP-QM7J9GBE\music`） |
| 端末側の宛先 | `/storage/emulated/0/Android/data/jp.hatsuboshi.funkotplayer/files/Music` |
| 開発コンテナ | イメージ `funkot-player-dev`、volume `funkot-player-android-home` |

**アプリを一度起動してから**転送する。Music フォルダはアプリが作る。
PC 側で先に作ると読めないことがある（README と同じ）。

**`ADB=1 ./dev.sh` では音源を push しない。** その入口は `/mnt/oldpc` を
マウントしない。下の `docker run` で music を明示マウントする。

---

## 1. 端末に接続

**アドレスを手で書かない。** `adb-device` が役割から探して返す（永続 adb
server も必要なら起動する）。どの端末が release 役かはこの PC 側の設定にある。

```sh
ADDR=$(adb-device release)
ADB=1 ./dev.sh adb -s "$ADDR" shell echo ok
```

見つからないときはスクリプトが端末側の確認手順を出す。ペアリングだけは人が要る
（コードと pair-port は端末の Wireless debugging 画面にしかない）:

```sh
ADB=1 ./dev.sh adb pair <ip>:<pair-port> <code>
```

release APK の入れ直しは:

```sh
./scripts/install-apk.sh release
```

---

## 2. 転送リスト（Music 相対パス）

1 行 1 パス。スラッシュ区切り。先頭の `/` や音源ルートは付けない。

```
Artist/Album/01 Track.m4a
single-track.mp3
```

Windows アプリが Funkot と判定済みの曲だけ送る場合の例:

1. Windows 側でライブラリをスキャン済みにする（`is_funkot` が解析結果に載る）
2. アプリデータ
   `%AppData%\jp.hatsuboshi.funkotplayer\`
   （WSL なら `/mnt/c/Users/<user>/AppData/Roaming/jp.hatsuboshi.funkotplayer/`）
   とエンジン解析キャッシュから `is_funkot == true` のエントリを拾う
3. 各ファイルの絶対パスを音源ルートからの相対パスに直してリスト化する

成功時は `testdata/funkot-rel-paths.txt`（412 行）を使った。作業用・コミット不要。

---

## 3. 転送スクリプト

コンテナ内パス固定版。ホストのリポジトリを `/work/funkot-player`、音源を
`/music` にマウントして使う。

`scripts/adb-push-music-list.py`:

```python
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
LIST = Path(sys.argv[2] if len(sys.argv) > 2 else "/work/funkot-player/testdata/funkot-rel-paths.txt")
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
```

---

## 4. 実行

転送用の `docker run` は `dev.sh` を通らないので、**転送前に
`./scripts/adb-server.sh start` と connect を済ませる**。`--network host` で
既存の 5037 に載る。server が先に 5037 を握っていないと、転送コンテナが独自に
server を立てて喧嘩する。

```sh
ADDR=$(adb-device release)   # server 起動と connect も済む

REPO=/home/yasuyuki/Projects/funkot-player
MUSIC=/mnt/oldpc/music

docker run --rm --network host \
  -v "$MUSIC:/music:ro" \
  -v "$REPO:/work/funkot-player" \
  -v funkot-player-android-home:/root/.android \
  funkot-player-dev \
  python3 /work/funkot-player/scripts/adb-push-music-list.py "$ADDR"
```

進捗・結果は `testdata/funkot-transfer.log`。完了行:

```text
DONE ok=412 fail=0 skip=0 total=412
```

中断したら同じコマンドを再実行する。サイズ一致は `SKIP`。

Wi‑Fi で数十 GB は **1 時間前後**かかり得る。コンテナが生きているかと
ログ末尾の `[n/total]` を見れば足りる。

---

## 5. 端末側

アプリで **⋮ → 再スキャン**。Funkot ゲート下でライブラリを確認する。

---

## ハマりどころ（成功時に潰したもの）

1. **`while read` + `adb`（シェル）** — adb が stdin を食ってループが壊れる。
   Python の `subprocess`（stdin 未接続）にすること。
2. **`ADB=1 ./dev.sh` 経由の push** — `/mnt/oldpc` がコンテナに見えない。
3. **ホストの `cat` が `bat` エイリアス** — heredoc でスクリプトを吐くときは
   `/usr/bin/cat` か Python でファイルを書く。
4. **wireless の port** — 再有効化のたびに変わる。だから `ADDR` を書き留めず、
   毎回 `adb-device <role>` に引かせる。
5. **release / debug の混在** — 署名が違う。役割は端末に固定。

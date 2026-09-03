# gitignore 対象データの分類と再生成

ignore 対象は、消えたときのコストで分かれる。**保護するのは「再生成不可」だけ。**
残りは消してよい。消す前にこの表で確認する。

| クラス | 対象 | 扱い |
|---|---|---|
| 再生成可能 | `src-tauri/target/`、`src-tauri/gen/`、`node_modules/`、`dist/`、`packaging/msix/{out,staging}/` | 消してよい。ビルドで戻る |
| 外部から再取得 | `.desktop-data/Music/`（267MB、手で入れた試聴用トラック）、`testdata/funkot-rel-paths.txt` | 消してよい。音源ルートから入れ直す |
| 高コストな派生 | `testdata/*-shots/`（UI 確認のスクショ、計 27MB）、`testdata/funkot-transfer*.log`、`testdata/push_manifest_p10.txt` | 消してよい。smoke を流し直せば取れる |
| キャッシュ・ローカル状態 | `.desktop-data/{CacheStorage,WebKitCache,funkot-cache,storage,logs,queue.json,session.json,window.json}`、`.win-run.stamp` | 消してよい |
| **再生成不可** | `HANDOFF.md`、`ISSUES.md` | **リポジトリ外の private store が正。** 所在は `HANDOFF.md` |
| 秘密 | `.secrets/upload-keystore.jks`、`src-tauri/gen/android/keystore.properties` | **リポジトリにもバックアップにも入れない。** 別途退避済み。`scripts/pack-signing-backup.sh` 参照 |

## 再生成

| 対象 | 手順 |
|---|---|
| `node_modules/` | `npm ci` |
| `src-tauri/target/`、`src-tauri/gen/` | 通常のビルド（`./dev.sh`） |
| `.desktop-data/Music/` | `GUI=1 ./dev.sh` で起動し、聴きたいトラックを入れる（`dev.sh` の該当コメント） |
| `testdata/funkot-rel-paths.txt` | 音源ルート `/mnt/oldpc/music` から相対パス一覧を作る。使い方は [`adb-music-transfer.md`](adb-music-transfer.md) |
| `testdata/*-shots/` | `scripts/smoke-cold-audition.sh <adb-addr>` / `scripts/smoke-tap-edit.sh <adb-addr>` |

## HANDOFF.md / ISSUES.md がなぜ守られないか

どちらも公開できないため ignore されている。foundation の release backup は
`git bundle create --all` で、**定義上 ignored ファイルを含まない**。promote 後の
release は clean clone なので、そこにも存在しない。

そのため実体はリリース系列の外の private store に置き、作業ツリーからは symlink で
参照する。新しい checkout ではそこから張り直すこと（手順は `HANDOFF.md`）。

## 新しく ignore を足すとき

置き場所で決める。**手で書いたスクリプトは `testdata/` に置かない。** `testdata/` は
実行の生データ（スクショ、ログ、生成された一覧）だけにして、スクリプトは `scripts/`、
残す知見は `docs/` へ置く。ignore の粒度を細かくするより置き場所を直す方が壊れにくい。

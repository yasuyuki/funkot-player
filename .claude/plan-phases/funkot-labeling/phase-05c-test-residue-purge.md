# 05c. テスト残骸の一掃と再解析

**リポジトリ:** funkot-player（設定）+ funkot-autodj-for-ui（旧 corpus の除去）
**依存:** **05b 完了必須。** ここで消すものの基準値は 05b にしか無い

## 目的

人が798曲を聴き始める前に、動作テストが残した状態をすべて消し、
**どこから来たか説明できる状態だけが残っている**ようにする。

いま残っているもの（実測）:

| 対象 | 状態 | 由来 |
|---|---|---|
| `history.json` | 8.9KB、8/20 20:41 | 04 の実機確認の再生履歴 |
| `session.json` | in-flight 2曲 | 同上 |
| `flags.json` | 1件 | テスト中のフラグ |
| `library.json` | `intro_bars: 48` 上書き1件 | テスト中の手動バー修正 |
| `funkot-cache` の1件 | `intro_bars_manual: true` | 上と同じハッシュ |
| `settings.json` | `allow_non_funkot: false` | **計画の必須前提と逆** |
| `C:\funkot-test` | funkot/ not-funkot/ EXPECTED.txt | 8/8 の Library 画面テスト用の振り分けコピー |
| `testdata/classify_*.txt` | 393件 | **内容が誤っている旧 corpus** |

キャッシュは **798件すべて削除する**（ユーザーの決定）。汚染は1件だけだが、
全消しには副次的な意味がある — 解析は決定的なので
（`funkot-autodj-for-ui/docs/labeling.md`「解析は決定的なので再解析で元の推定値に戻る」）、
**再解析後の値が 05b の凍結値と一致することが、決定性そのものの検証になる。**
一致しなければ非決定性の証拠なので、そこで止めてリードへ返す。

## 対象範囲

### (a) アプリ実データの初期化（アプリ終了中に行う）

`%APPDATA%\jp.hatsuboshi.funkotplayer` で:

**削除する**

- `funkot-cache/*.json`（798件）
- `history.json` / `session.json` / `queue.json` / `flags.json` / `library.json`

**残す**

- `labels.json` — 既に `{}`。空なので消す理由がない
- `hash-index.json` — 内容ハッシュは不変。消すとタグの再読込が余計に走る
- `dismissed.json` — 既に空
- `Music/` — アプリ同梱のフォルダ。ライブラリは UNC 側であり無関係

**書き換える**

- `settings.json` の `allow_non_funkot` を **`true`** へ。
  OFF だとフォルダ巡回が解析済み非Funkot をスキップし（`lib.rs:2394-2399`）、
  **偽陰性＝最も確認したい曲が一度も再生されない**。忘れると798曲パス全体が無効になる
- `settings.json` の `labeling_mode` を **`true`** へ。04 の仕様どおり
  **次回の ▶（`doStart`）から有効**（アプリ再起動は不要）
- `music_dir` は触らない（`\\LAPTOP-QM7J9GBE\music`）

### (b) テスト用分類コピーの削除

`C:\funkot-test` を削除する（`funkot/` `not-funkot/` `EXPECTED.txt`）。
旧 corpus の判定で振り分けた m4a のコピーであり、由来が誤りなので保全しない。

### (c) 旧 corpus の除去

`funkot-autodj-for-ui/testdata/` の3ファイルを削除する:

- `classify_funkot.txt`（69行）
- `classify_funkot_hhhb.txt`（63行）
- `classify_not_funkot.txt`（261行）

**未追跡の単一コピーなので、削除前に 05b のバックアップ先へ退避する**
（`<bak>/testdata-corpus/` へ移す）。誤りと確定した以上、`testdata/` に置いておくと
次の誰か（人でもエージェントでも）が正解データとして拾う。

`file_list.txt` / `real_playlist*.txt` / `ivy_transition_playlist.txt` /
`labels.tsv.example` は**触らない**。用途が別。

### (d) 再解析（ユーザー作業を含む）

アプリを起動 → 再スキャン → 798曲の解析完了まで待つ。
**再スキャンしたらアプリを再起動する** — フォルダ巡回の曲リストは `start` 時点の
スナップショット（`lib.rs:3076` → `lib.rs:3168`）で、再スキャンしても切り替わらない。

## 対象外

- `labels.json` の削除。空なので触らない
- `CACHE_VERSION` の変更
- 判定ロジック・しきい値の変更（phase-06）
- 05b の生成物（`classify_baseline_798.tsv` / `path_map_798.tsv`）の削除。**残す**
- `%APPDATA%\jp.hatsuboshi.funkotplayer.guard-bak` など既存のバックアップ

## 関連ファイル

| パス | 役割 |
|---|---|
| `%APPDATA%\jp.hatsuboshi.funkotplayer\` | 初期化対象 |
| `src-tauri/src/store.rs:49-58` | 各 JSON のファイル名定数。消してよい対象の正本 |
| `src-tauri/src/lib.rs:2394-2399` | `allow_non_funkot` OFF のスキップ |
| `src-tauri/src/lib.rs:3076`, `lib.rs:3168` | 巡回リストのスナップショット |
| `funkot-autodj-for-ui/testdata/classify_*.txt` | 除去対象の旧 corpus |
| `funkot-autodj-for-ui/docs/labeling.md`「汚染されたキャッシュで評価しないこと」 | 決定性と manual フラグ検査の根拠 |
| `C:\funkot-test\` | 除去対象 |

## 制約・不変条件

- **アプリを終了してから書き換える。** 起動中の書き換えは終了時に上書きされる
- 05b のバックアップが実在することを**先に確認する**。無ければ何も消さずに止まる
- `settings.json` は**キーを消さずに値だけ**変える。他のキーの順序も保つ
- 旧 corpus は**移動であって削除ではない**。退避先に3ファイルが揃ってから
  `testdata/` 側を消す
- **リポジトリのコミットはしない。** このフェーズが触るのは gitignored なファイルと
  リポジトリ外のパスだけ。`git status` に差分が出たらそれ自体が異常

## 受け入れ条件

再解析完了後、次のすべてを満たす:

1. `funkot-cache` が **798件**、全件 `version: 14`、`classify_scores` 完備
2. `*_manual: true` が **0件**、`needs_reanalysis: true` が **0件**
3. `is_funkot: true` が **412件**（05b の凍結値と一致）
4. 再生成した TSV が `classify_baseline_798.tsv` と **全798行で完全一致**
   （差が出たら止めてリードへ返す。差分行を報告に貼る）
5. `labels.json` が `{}`、`history.json` / `session.json` / `flags.json` /
   `library.json` が存在しない
6. `settings.json` が `allow_non_funkot: true` かつ `labeling_mode: true`、
   `music_dir` は変更なし
7. `C:\funkot-test` が存在しない
8. `testdata/classify_funkot.txt` / `classify_funkot_hhhb.txt` /
   `classify_not_funkot.txt` が存在せず、`<bak>/testdata-corpus/` に3ファイルある
9. `git -C funkot-player status --short` と
   `git -C funkot-autodj-for-ui status --short` がどちらも空

## 検証コマンド

```bash
APP=/mnt/c/Users/<user>/AppData/Roaming/jp.hatsuboshi.funkotplayer
BAK=$(ls -dt ${APP}.bak-* | head -1)

ls "$APP/funkot-cache" | wc -l                                        # 798
grep -l '"version": 14' "$APP"/funkot-cache/*.json | wc -l            # 798
grep -lE '"(intro|outro|outro_structure)_bars_manual" *: *true' "$APP"/funkot-cache/*.json | wc -l   # 0
grep -lE '"needs_reanalysis" *: *true' "$APP"/funkot-cache/*.json | wc -l                            # 0
grep -lE '"is_funkot" *: *true' "$APP"/funkot-cache/*.json | wc -l    # 412
grep -lE '"classify_scores" *: *null' "$APP"/funkot-cache/*.json | wc -l                             # 0

cat "$APP/labels.json"                                                # {}
ls "$APP"/history.json "$APP"/session.json "$APP"/flags.json "$APP"/library.json 2>&1   # 全て No such file
cat "$APP/settings.json"                                              # allow_non_funkot: true

ls /mnt/c/funkot-test 2>&1                                            # No such file
ls "$BAK/testdata-corpus"                                             # classify_*.txt 3件

# 05b の TSV を同じ手順で再生成して比較（差分ゼロであること）
cd <workspace-root>/funkot-autodj-for-ui
diff testdata/classify_baseline_798.tsv testdata/classify_baseline_798.recheck.tsv && echo IDENTICAL

git -C <workspace-root>/funkot-player status --short
git -C <workspace-root>/funkot-autodj-for-ui status --short
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ。削除と移動を区別する
2. **実装内容** — 削除・保持・書き換えの内訳と、それぞれの根拠
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に受け入れ条件4の `diff` 結果
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — 再解析にかかった時間、決定性の一致/不一致、
   `labeling_mode: true` のまま人が触ることの影響
   （ISSUES.md 既出: ラベリング中はキュー表示の「次の曲」が最大12曲ずれるので
   並べ替え・削除をしない前提）

## ユーザー作業（このフェーズの途中で必ず発生する）

エージェントだけでは完結しない。以下は人がやる:

1. アプリを終了する（エージェントの書き換え前）
2. 書き換え後にアプリを起動し、⋮ → 再スキャン
3. 再スキャン後にアプリを再起動する（巡回リストのスナップショット更新のため）
4. 798曲の解析が終わるまで待つ

これらの前後でエージェントへ制御を戻すこと。**待ちの間に他のフェーズへ進まない。**

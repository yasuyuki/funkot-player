# 05d. 自己一致率 30曲×2 の道具立て

**リポジトリ:** funkot-player / **依存:** なし（05b / 05c と並行してよい）
**使うのは:** 05c 完了後、798曲パスに入る前

## 目的

README と phase-05 が要求する「30曲をランダムに選んで2回ラベル付けし、自己一致率を
測る」を、**実際に測れるようにする**。

いまの実装では測れない。`labels.json` は
`Labels` / `TrackLabel`（`src-tauri/src/store.rs`）で、
**ハッシュごとに判定を1つしか持たない**。2回目のラベル付けは1回目を上書きするので、
2つのパスを比べる手段が無い。人が聴き始めてから気付くと、30曲を聴き直すことになる。

自己一致率が何を決めるか: 自己一致が9割なら、分類器がそれを超える精度を示しても
意味が無い。**「目標の精度」が何を指しうるかがこれで決まる**ので、
798曲パスに入る前に測る。

## 対象範囲

`funkot-player/scripts/label-agreement.py` を新規追加する。
既存の `scripts/adb-push-music-list.py` と同じ置き場・同じ素の Python
（標準ライブラリのみ。依存を足さない）。

サブコマンド:

### `sample --seed <n> --count 30 --out <sample.tsv>`

`hash-index.json` から**決定的に**選ぶ。同じ seed なら常に同じ30行。
出力はヘッダ付き TSV:

```
hash	rel_path	title	artist
```

並びは巡回順（絶対パスのソート順。`scan_tracks`（`src-tauri/src/lib.rs`）と同じ）に
そろえる。人はこの一覧を見ながらアプリの検索ボックスで曲を引く。

### `snapshot --out <pass-N.json>`

`labels.json` をそのまま退避する。パス1回目のあと、2回目のあとに1回ずつ実行する。

### `clear --sample <sample.tsv>`

`labels.json` から**サンプル30曲分のラベルだけ**を消す。他の曲のラベルには触らない。
2回目のパスへ入る前に実行する。

### `agreement --a <pass-1.json> --b <pass-2.json> --sample <sample.tsv>`

30曲について次を出す:

- 一致率（一致件数 / 両方にラベルがある件数）
- Cohen's κ
- 不一致行の一覧（`rel_path` と両パスの判定）
- 片方にしかラベルが無い件数（＝聴き逃し。母数から外したことを明示する）

### `--self-test`

合成データで一致率と κ を計算し、手計算値と突き合わせる。実データに触らない。

## 対象外

- UI の変更。アプリ側で2回目のラベリングを支援する仕組みは作らない
- `labels.json` のスキーマ変更。`TrackLabel` は触らない
- 30曲を選ぶ基準の作り込み（層化抽出など）。**一様ランダムでよい。**
  測っているのは分類器の精度ではなく人の再現性
- 798曲パスそのものの進捗管理。それは phase-05 の UI が持つ

## 関連ファイル

| パス | 役割 |
|---|---|
| `scripts/adb-push-music-list.py` | 置き場と書き方の手本 |
| `LABELS_FILE` / `TrackLabel` / `load_labels` / `save_labels`（`src-tauri/src/store.rs`） | `labels.json` のファイル名・型・読み書き |
| `TrackRow`（`src-tauri/src/lib.rs`） | `TrackLabel` の意味（`None` は未ラベル） |
| `scan_tracks`（`src-tauri/src/lib.rs`） | `scan_tracks` の並び（巡回順の正本） |
| `%APPDATA%\jp.hatsuboshi.funkotplayer\hash-index.json` | サンプル抽出の母集合（798件） |
| `%APPDATA%\jp.hatsuboshi.funkotplayer\labels.json` | 読み書き対象 |

## 制約・不変条件

- **アプリ終了中にしか `labels.json` へ書き込まない。** 起動中の書き換えは
  終了時に上書きされる。`clear` は実行前にアプリの終了を確認させる
- 書き込み前に必ず `labels.json` のバックアップを取る（タイムスタンプ付き）
- `clear` は**サンプル外のキーを1つも消さない**
- 標準ライブラリのみ。`requirements.txt` も仮想環境も足さない
- 読み書きは UTF-8 固定。曲名に日本語・記号が入る
- `%APPDATA%` の場所を決め打ちしない。引数か環境変数で受ける

## 受け入れ条件

1. `python3 scripts/label-agreement.py --self-test` が通る。合成データの一致率と κ が
   手計算値と一致する
2. `sample` を同じ seed で2回実行すると**同一の30行**が出る
3. `sample` の出力が巡回順（絶対パスのソート順）に並んでいる
4. `clear` がサンプル外のラベルを消さない（サンプル外を含む合成 `labels.json` で検証）
5. `clear` / `snapshot` がバックアップを残す
6. `agreement` が、片方にしかラベルが無い曲を母数から外し、その件数を出力する
7. `git -C funkot-player status --short` の差分が `scripts/label-agreement.py` の
   1ファイルだけ

## 検証コマンド

```bash
cd <workspace-root>/funkot-player

python3 scripts/label-agreement.py --self-test

APP=/mnt/c/Users/<user>/AppData/Roaming/jp.hatsuboshi.funkotplayer
python3 scripts/label-agreement.py sample --app-dir "$APP" --seed 20260820 --count 30 --out /tmp/s1.tsv
python3 scripts/label-agreement.py sample --app-dir "$APP" --seed 20260820 --count 30 --out /tmp/s2.tsv
diff /tmp/s1.tsv /tmp/s2.tsv && echo DETERMINISTIC
wc -l /tmp/s1.tsv        # 31（ヘッダ込み）

git status --short
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 各サブコマンドの入出力、決定的抽出の方法、κ の式、
   バックアップの命名
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に `--self-test` と `DETERMINISTIC`
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）。
   母数の定義（片側だけラベルがある曲の扱い）を含む
6. **未解決事項と残存リスク** — アプリ起動中に実行された場合の壊れ方、
   30曲という数で κ の信頼区間がどれだけ広いか

## 使い方（人がやる手順。このフェーズでは実行しない）

1. アプリを終了する
2. `sample` で30曲の一覧を出す
3. アプリを起動し、一覧の曲を検索ボックスで引いて聴き、`F` / `J` で判定する
4. アプリを終了し、`snapshot --out pass-1.json`
5. `clear --sample sample.tsv`
6. アプリを起動し、**一覧を見ずに**もう一度30曲を判定する
7. アプリを終了し、`snapshot --out pass-2.json`
8. `agreement` で一致率と κ を出す

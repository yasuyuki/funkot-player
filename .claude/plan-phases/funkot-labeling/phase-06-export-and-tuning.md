# 06. エクスポート・突合・しきい値調整

**リポジトリ:** funkot-player + funkot-autodj-for-ui
**依存:** 01（スコア）・02（ラベル）・05・05a–05e 完了後に**798曲を聴き終えていること**

**ここまでが「ラベルを集める」。精度を上げるのはこの計画。**

## 目的

人手ラベルを正解データとして、しきい値を調整し、精度を測り直す。

## 対象範囲

### (a) エクスポート（funkot-player）

- `export_labels()` コマンド — 人手ラベルから Funkot / 非 Funkot のパス一覧を生成する
- 出力は**1行1絶対パス**（`/mnt/oldpc/music/<rel>`）
- パス変換の実体は `\\LAPTOP-QM7J9GBE\music\<rel>` ↔ `/mnt/oldpc/music/<rel>`。
  後者は WSL 再起動でマウントが外れるので着手時に `oldpc-music`
- Windows で作業しているので、music_dir 基準の相対パスから
  `/mnt/oldpc/music/...` へ変換する経路が要る

### (c) しきい値調整（funkot-autodj-for-ui）

- `classify_probe` をキャッシュ済みスコア（01 で保存）から回す。
  掃引の入力は **05b の `classify_baseline_798.tsv`**。798曲の掃引が**ミリ秒で終わる**
- 掃引対象は3つ（`CLASSIFY_MIN_Z` / `CLASSIFY_MIN_Z_RATIO` / `CLASSIFY_MAX_HALF_RATIO`（`funkot-core/src/analysis.rs`））:

  | 定数 | 現在値 | 現在の根拠 |
  |---|---|---|
  | `CLASSIFY_MIN_Z` | 8.5 | 旧 corpus 由来。**要再算定** |
  | `CLASSIFY_MIN_Z_RATIO` | 0.75 | 同上 |
  | `CLASSIFY_MAX_HALF_RATIO` | 1.40 | 同上 |

- 混同行列を出す。**しきい値を更新したら、定数のコメントに書かれている根拠も
  人手ラベル基準で書き直すこと**（現在のコメントは旧 corpus の数字）

### (d) 精度の再測定

- `CHANGELOG` の精度表を人手ラベル基準で書き直す
- **旧の「69/69・60/63・偽陽性 20/261」は誤ったデータから出ている数字なので、
  そのまま残さない。** 循環しているだけなら測り直せば救えるが、元データが誤っている場合は救えない

## 対象外

- 判定アルゴリズム自体の変更（特徴量の追加など）。まずは現行の3特徴量で
  しきい値をどこまで追い込めるかを見る。それで届かないことが**データで示せて
  から**アルゴリズムの話に進む
- 分類器の再設計

## 制約・不変条件

- 判定の3条件の構造（`GridLock::verdict`（`funkot-core/src/analysis.rs`）、head/tail の良い方を
  採る + 半速拒否）は変えない。動かすのは値だけ
- しきい値変更後は `CACHE_VERSION` の bump が要るか判断すること
  （判定結果が変わるがスコアは変わらないので、**bump 不要**のはず。
  ただし `is_funkot` はキャッシュに保存されているので、
  既存エントリの再判定をどう反映するかを決める必要がある）

## 受け入れ条件

1. `export_labels` が旧 corpus と同形式のパス一覧を吐く
2. `classify_probe` がキャッシュ済みスコアから798曲を再デコードなしで処理する
3. 人手ラベル基準の混同行列が出る
4. しきい値更新後、**05 で測った自己一致率と比べて意味のある精度**が出ている
   （自己一致率を超える精度は測定できない）
5. `CLASSIFY_MIN_Z` / `CLASSIFY_MIN_Z_RATIO` / `CLASSIFY_MAX_HALF_RATIO`（`funkot-core/src/analysis.rs`）のコメントが人手ラベル基準の数字に更新されている
6. `CHANGELOG` の精度表が更新されている
7. `cargo test -p funkot-core` が通る

## 検証コマンド

```bash
cd ../funkot-autodj-for-ui
cargo run --release --example classify_probe
cargo test -p funkot-core
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — エクスポート形式、しきい値の掃引結果、定数コメントと CHANGELOG の更新内容
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に混同行列、自己一致率との比較
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）。`CACHE_VERSION` bump 要否の判断を含む
6. **未解決事項と残存リスク** — 30秒未満で掃引から外した曲数、しきい値変更後のゲート見え方

## 注意

- **`MIN_DURATION_SECS = 30.0`（`MIN_DURATION_SECS`（`funkot-core/src/analysis.rs`））未満の曲は解析がエラーになり、
  スコアが無い。** 手動ラベルは付いていてもしきい値調整には使えないので、
  掃引の母集合から外すこと。何曲該当したかは記録する。一般論としては正しいが、
  **このライブラリでは発生しない**（件数は `./scripts/labeling-facts.sh`）
- 30秒未満の曲は未解析扱いでゲートも掛からない（`gated_non_funkot` は
  `analyzed_cache_entry` が `None` なら `false` を返す、`gated_non_funkot`（`src-tauri/src/lib.rs`））。
  ISSUES.md に既出の問題
- しきい値を動かすと `allow_non_funkot` OFF での曲の見え方が変わる。
  ユーザーのライブラリで何曲が新たに除外/追加されるかを事前に出すこと

## 完了後

- `HANDOFF.md`（funkot-player とリポジトリルートの両方）を書き換える
- ISSUES.md から「Non-Funkot を再生中であることを示すアイコンが無い」の行を消す
  （05 で解消済み）
- 新しいパス一覧は `funkot-autodj-for-ui/testdata/` に置く。同ディレクトリは
  `funkot-autodj-for-ui/.gitignore` が `/testdata/*` を除外しており未追跡。
  除外理由は**ユーザーの実ライブラリのファイル一覧を public repo へ出さないため**。
  コミットしない。差し替え前に 05b のバックアップ先へ現行ファイルを退避する

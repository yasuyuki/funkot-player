# 01. 判定スコアの保存

**リポジトリ:** funkot-autodj-for-ui のみ / **依存:** なし

## 目的

Funkot 判定のスコア（`z` / `z_ratio` / `half_ratio`）を解析キャッシュに残し、
しきい値調整を再デコードなしで回せるようにする。

現状 `classify_is_funkot`（`funkot-core/src/analysis.rs:1380`）は
`GridLock::verdict`（同:1409）で3条件を見て **bool しか返さない**。
`funkot-core/src/lib.rs:159` に『the scores themselves are not stored』と明記済み。
スコアを見る唯一の手段は `probe_classification`（`analysis.rs:1536`）→
`examples/classify_probe` で、これは **`analyze` とは別経路で音声を再デコード・
再解析する**（`analysis.rs:1547-1553`）。798曲では非現実的。

## 対象範囲

- `funkot-core/src/analysis.rs` — `classify_is_funkot` が判定 + head/tail 各3値を返す。
  測定は `SideLock::measure`（同:1417）が**既に計算済み**なので新規計算は無い
- `funkot-core/src/lib.rs` — `ClassifyScores { head_z, head_z_ratio, head_half_ratio,
  tail_z, tail_z_ratio, tail_half_ratio }` を追加。`TrackAnalysis` に
  `classify_scores: Option<ClassifyScores>`（`#[serde(default)]`）として持たせる
- `funkot-core/src/cache.rs:22` — `CACHE_VERSION` 13 → 14。同:14-21 の慣習に従い
  bump 理由を1行残す
- `funkot-core/examples/classify_probe.rs` — キャッシュにスコアがあればそれを読み、
  無いときだけ再デコードにフォールバック

## 対象外

- しきい値（`CLASSIFY_MIN_Z` 8.5 / `CLASSIFY_MIN_Z_RATIO` 0.75 /
  `CLASSIFY_MAX_HALF_RATIO` 1.40、`analysis.rs:63,68,74`）の値は**変更しない**。
  調整は 06 で正解データが揃ってから
- 判定結果（`is_funkot` の真偽）が現行と変わってはならない
- funkot-player 側は触らない

## 制約・不変条件

- `TrackAnalysis` のフィールド追加は既存の `#[serde(default)]` 慣習に従う
  （前例: `track_bars` / `outro_structure_bars`）
- `CACHE_VERSION` bump は解析キャッシュを**全破棄**する（`cache.rs:74-82` は
  version 不一致で `None` を返す）。手修正した小節数は `*_manual` +
  `reapply_overrides`（player `lib.rs:5137`）で生き残る設計だが、
  **bump 前に現物のキャッシュディレクトリを確認すること**
- `classify_is_funkot` は private 関数で `analyze()`（`analysis.rs:289`）からのみ
  呼ばれる。呼び出し側の変更は1箇所で済むはず

## 受け入れ条件

1. `cargo test -p funkot-core` が通る
2. `CACHE_VERSION == 14`、`cache.rs:14-21` に bump 理由の行が増えている
3. 新規に解析した曲の `{hash}.json` に head/tail 各3値が入る
4. **判定結果が変わらない** — 既存の分類テストが判定の真偽について緑のまま
5. `classify_probe` がキャッシュ済みスコアを使う経路で動き、
   再デコードなしで TSV を出す
6. スコアが無い（version 14 以前の）エントリでも panic せず、
   再デコードにフォールバックする

## 検証コマンド

```bash
cd ../funkot-autodj-for-ui
cargo test -p funkot-core
cargo run --release --example classify_probe    # キャッシュ経由でスコアが出ること
grep -n "CACHE_VERSION" funkot-core/src/cache.rs
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — スコア保存と `CACHE_VERSION` bump をどう実現したか
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に `CACHE_VERSION == 14`、判定真偽が変わっていないこと、`classify_probe` がキャッシュ経路で動いたこと
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — 798曲の再解析が走ったか／残っているか、確認できなかったもの

## 注意

- この計画の完了後、**798曲の全再解析が必要になる**。player を起動して
  `spawn_analysis_worker`（`lib.rs:5203`、**単一スレッド直列**）に流させる。
  1回きりの長時間パスなので放置できる時間帯に走らせる
- 05 の完了（798曲を聴き始める）までに必ず終わらせること。後回しにすると
  全曲解析を2回払う

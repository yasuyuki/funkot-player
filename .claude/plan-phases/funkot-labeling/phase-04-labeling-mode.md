# 04. ラベリングモード（head のみ伸長）

**リポジトリ:** funkot-autodj-for-ui + funkot-player / **依存:** なし
**この6件の中で最も慎重を要する。**

## 目的

「次の曲」を待ちなく連打できるようにする。798曲を1曲ずつ聴いて判断する作業で、
現状は1曲ごとに**約8秒**待たされる。

## 待ちの正体（調査済み・再調査不要）

`⏭ 次の曲` は `reserved_prepared`（`lib.rs:4293`）が立つまで押せない
（`transportMode.ts:62-70` の `canSkipNext`）。これは `NEXT_PREPARED`
（`lib.rs:2223`）= 次曲の**デコード + 全曲タイムストレッチ完了**を意味する。

全曲ストレッチは**7–8分FLACで約8秒**（`engine.rs:2070-2072` の実測コメント）。
798曲なら純粋な待ち時間だけで1.5時間を超える。

**解析はすでに前倒し済み**（`spawn_analysis_worker` `lib.rs:5203`）なので、
初期解析へ回せる処理は残っていない。残っているのはストレッチで、これは音声なので
JSON キャッシュには載らない（`cache.rs:1`「JSON analysis cache」）。

## 対処: `prepare_first_live` の head 方式を全曲へ

`engine.rs:2076` の `prepare_first_live` が既に「頭20秒だけ伸ばして先に鳴らし、
フルは後追いで差し替える」を実装済み。**20秒 head なら約0.3秒**（同:2070-2072）。
1曲目だけの仕組みを、ラベリング中は全曲に広げる。

## 対象範囲

### funkot-autodj-for-ui

- `funkot-core/src/engine.rs` — `EngineOptions` に `head_only_secs: Option<f64>` を追加
- `prepare_one`（`engine.rs:2062`）が、これが `Some` のとき `prepare_track` ではなく
  head プレビューのみを作り、**Upgrade を送らない**
- `finish_prepare(..., preview = true)` は既に「outro を EOF に留めて暫定 mix point が
  早発しないようにする」実装なので、そのまま受け皿に使える

### funkot-player

- `store.rs` の `Settings` に `labeling_mode: bool`（`#[serde(default)]`）。
  `allow_non_funkot`（`store.rs:228-235`）と同じ形
- `get_labeling_mode` / `set_labeling_mode` コマンド。
  `get_allow_non_funkot` / `set_allow_non_funkot`（`lib.rs:4093,4102`）が見本
- `OverflowMenu.svelte` にトグル（既存の「非Funkotも再生」`OverflowMenu.svelte:107-119`
  の隣）
- エンジン起動時に `head_only_secs` へ反映

### head の開始位置

頭20秒が静かなイントロだと Funkot 判定に使えない。解析済みの `first_downbeat` が
キャッシュにあるので、**head 窓をそこから取る**。追加コストはほぼゼロで、
798曲ぶんの「イントロを待つ時間」が消える。

## 対象外

- ストリーミング化。DSP 上は可能（`signalsmith_stretch::Stretch` は元々
  `process` / `input_latency` / `output_latency` / `flush` を持つストリーミング API で、
  現在使っている `exact()`（`stretch.rs:283`）はその上の全バッファ版ラッパ。
  rubato もブロック処理）。しかし `PreparedTrack.samples`（`engine.rs:64`）の
  全曲materialized前提、末尾依存の `derive_outro_start_out`（`engine.rs:2455`）、
  曲ペア依存の `align_next_entry_with_phase_hypotheses` を作り直す
  **2リポジトリ跨ぎのエンジンアーキテクチャ変更**になる。
  ラベリングには不要（トランジションが要らないので末尾も曲ペアも不要）。
  **本番再生の即時開始という別の実利はあるので、別案件として起票する**
- 通常モードの再生経路。`labeling_mode` が false のとき挙動が変わってはならない

## 制約・不変条件

- **`labeling_mode` が false のとき、既存の再生・トランジション挙動が
  1ミリも変わらないこと。** これが最重要
- ラベリング中はトランジションが成立しない前提。スキップは**ハードカット**として
  確実に動くこと
- `EngineOptions` の `rate` は現行コードが「never 上書き」と明言している
  （`lib.rs:3571-3577`）。触らない

## 実装前に必ず確認すること

**`preview: true` のトラックに対して `NavAction::TransitionToNext` がどう振る舞うか。**
`engine.rs:1068-1072` は `next_track` が `None` のとき黙って落とす。
head のみのトラックが連続する状況で、

- スキップが確実に次曲へ進むか
- 暫定 mix point が早発しないか（`finish_prepare` の preview 経路が守るはず）
- 無音や取りこぼしが出ないか

を**実装前に読み切り、テストで固定してから**本実装に入ること。ここを飛ばすと
798曲のパスの途中で壊れる。

## 受け入れ条件

1. `cargo test -p funkot-core` と
   `cargo test --manifest-path src-tauri/Cargo.toml` が通る
2. `labeling_mode = false` で既存のトランジション動作が変わらない
   （既存のトランジション関連テストが緑）
3. `labeling_mode = true` で `⏭ 次の曲` を10回連打でき、**毎回待ちが体感ゼロ**
4. ラベリング中のスキップでハードカットが確実に成立し、無音・取りこぼしが無い
5. head 窓が `first_downbeat` から取られ、イントロ待ちが無い
6. `⋮` メニューからトグルでき、再起動なしで切り替わる
7. 新規テスト: preview トラック連続時のスキップ挙動

## 検証コマンド

```bash
cd ../funkot-autodj-for-ui
cargo test -p funkot-core

cd ../funkot-player
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
./scripts/win-run.sh -ForceBuild
```

実機で:
- `labeling_mode` OFF → 通常のつなぎが従来通りであることを目視・耳で確認
- `labeling_mode` ON → 10曲連続スキップして待ちが無いことを確認

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — `head_only_secs` と `labeling_mode` の接続、スキップがハードカットになる経路
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に OFF 時の既存トランジション不変と、ON 時の連打待ち
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — preview 連続時の NavAction 挙動で読み切れなかった点、実機確認の残り

## 注意

- リリースビルドで確認すること。デバッグビルドはストレッチが約26倍遅く
  （`src-tauri/Cargo.toml:66-81`: 最適化なし162秒 vs あり6.3秒）、
  待ち時間の評価にならない
- コストの主体は Signalsmith のストレッチ DSP（同:78-80）

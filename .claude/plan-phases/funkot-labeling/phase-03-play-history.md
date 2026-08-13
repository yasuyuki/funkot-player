# 03. 再生履歴

**リポジトリ:** funkot-player（バックエンド + 表示1箇所） / **依存:** なし

## 目的

「実際にチェックしたかデータから特定できるようにする」ため、どの曲をいつ何回
再生したかを記録する。ラベルと履歴の差分が「聴いたが判断を保留した曲」になる。

現状**再生履歴は一切存在しない**（`play_count` / `played_at` / `last_played` /
`history` いずれも `lib.rs` / `store.rs` / `queue.rs` でヒット0件）。

## 対象範囲

### `src-tauri/src/store.rs`

- `HISTORY_FILE = "history.json"` を定数一覧（`store.rs:45-52`）に追加
- `PlayRecord { count: u32, last_played_ms: u64 }`、
  `History = BTreeMap<String, PlayRecord>`（キーは content hash）
- `load_history` / `save_history` — `load_flags` / `save_flags`
  （`store.rs:656-678`）と同形

### `src-tauri/src/lib.rs`

- **書き込み地点は「実際に現在曲になった時点」。** `NowTracker` の
  transition started で `to` が現在曲になる箇所に足す
- **`on_reserved`（`queue.rs:396-412`）ではない。** あれは「予約した」であって
  「聴いた」ではない。キューに積んだだけの曲を再生済みにしてはならない
- `TrackRow`（`lib.rs:4310`）に `played_at_ms: Option<u64>` を追加
- `src/lib/tauri.ts` の `TrackRow` interface に**同名で**ミラー

### 表示（最小限）

- `AllTracks.svelte` の行に再生済み印を出す。UI の作り込みは 05 に任せ、
  ここでは「データが届いていること」が分かる最小の表示で足りる

## 対象外

- 再生履歴の一覧画面・統計画面
- 履歴に基づく選曲（戦略上むしろ反対側 — `docs/strategy.md` 参照）
- エクスポート

## 制約・不変条件

- content hash がキー
- ユーザー所有データなので `data_dir` 直下。解析キャッシュに置かない
- `SAVE_LOCK` のロック順序（`lib.rs:2400-2420`）を守る
- 保存失敗は warn のみ。**再生を止めない**
- 履歴書き込みが cpal のオーディオコールバック上で走らないこと。
  ファイル I/O をリアルタイムスレッドに載せない

## 受け入れ条件

1. `cargo test --manifest-path src-tauri/Cargo.toml` が通る
2. 3曲続けて再生すると `history.json` に3件入り、`count` と `last_played_ms` が
   正しい
3. **キューに積んだだけで再生していない曲は履歴に入らない**
4. 同じ曲を2回再生すると `count` が 2 になる
5. アプリ再起動後も履歴が残る
6. 再生が履歴書き込みで途切れたり音飛びしたりしない

## 検証コマンド

```bash
# funkot-player のリポジトリルートで実行
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
./scripts/win-run.sh -ForceBuild
```

実機で3曲再生 → `history.json` を確認 → 再起動して残っていることを確認。

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 書き込み地点と `history.json` の形、「聴いた」の定義をどう固定したか
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に「キューに積んだだけは入らない」と count の増加
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — 実機の音飛び有無など、確認できなかったもの

## 注意

- 「聴いた」の定義を実装前に1行で決めて、コードコメントに残すこと
  （曲が現在曲になった瞬間か、一定秒数以上鳴ったか）。ラベリングでは高速に
  スキップするので、**秒数の閾値を入れると全曲が履歴に入らなくなる**恐れがある。
  現在曲になった時点で記録するのが無難

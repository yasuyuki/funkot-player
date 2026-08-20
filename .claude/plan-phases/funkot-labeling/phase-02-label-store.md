# 02. ラベル永続化とコマンド層

**リポジトリ:** funkot-player（バックエンドのみ） / **依存:** なし

## 目的

人が付けた Funkot / 非Funkot ラベルを保存し、フロントから読み書きできるように
する。UI は 05 で作るので、ここではコマンド層まで。

## なぜ `BarOverride.funkot` だけでは足りないか

`BarOverride::funkot`（`src-tauri/src/store.rs`）の `funkot: Option<bool>` は**「解析を上書きする」**意味で、
`None` が「意見なし」と「解析に同意」を区別できない。正解データには
**「人が非Funkotと判定した」と「まだ聴いていない」の区別が必須**。
798曲中「解析も人も非Funkot」の曲が、未着手の曲と見分けられなくなる。

## 設計: `labels.json` が正、`BarOverride.funkot` はそこから派生

`set_label` は labels.json に書き、**同じ値を `BarOverride.funkot` にミラーする**。
こうすると既存の読み取り経路 — `effective_is_funkot`（`src-tauri/src/store.rs`）、
`gated_non_funkot`（`src-tauri/src/lib.rs`）、`track_row`（`src-tauri/src/lib.rs`）、既存テスト
（`bar_override_funkot_round_trip`（`src-tauri/src/store.rs`）、`gated_non_funkot_skips_only_analysed_non_funkot`（`src-tauri/src/lib.rs`））— が**一切変更なしで動く**。
ミラーは一方向（label が正）であることをコメントで明示する。

## 対象範囲

### `src-tauri/src/store.rs`

- `LABELS_FILE = "labels.json"` を定数一覧（`LABELS_FILE`（`src-tauri/src/store.rs`））に追加
- `TrackLabel { verdict: bool, labeled_at_ms: u64 }`、
  `Labels = BTreeMap<String, TrackLabel>`（キーは content hash）
- `load_labels` / `save_labels` — `load_flags` / `save_flags`（`src-tauri/src/store.rs`）を
  そのまま踏襲。欠損・破損は空マップで起動して warn

### `src-tauri/src/lib.rs`

| コマンド | 用途 |
|---|---|
| `set_label(path, verdict: Option<bool>) -> TrackRow` | 1曲。`None` で取り消し |
| `set_folder_label(dir, verdict) -> usize` | フォルダ配下を一括。付与件数を返す |
| `label_stats() -> LabelStats` | `{ labeled, total, funkot, not_funkot }` |

- `TrackRow`（`src-tauri/src/lib.rs`）に `label: Option<bool>` を追加
- `generate_handler!`（`src-tauri/src/lib.rs`）に3本を登録

見本にする既存実装: `set_bars_impl`（`src-tauri/src/lib.rs`）と
`dismiss_flags`（`src-tauri/src/lib.rs`）。どちらも `SAVE_LOCK` を取り、
更新後の値を返して UI が即反映できる形。

### `src/lib/tauri.ts`

- `TrackRow` interface に `label` を**同名で**追加。
  `snake_case`（`src/lib/tauri.ts`）に「serde の snake_case をそのままミラーせよ、ズレると
  silently undefined」と明記されている

## 対象外

- UI（05 で作る）
- キーボードショートカット（05）
- エクスポート（06）
- `BarOverride.funkot` の読み取り経路 — 変更不要

## 制約・不変条件

- content hash がキー。パス変更・リネームに耐える（`content_hash`（`src-tauri/src/store.rs`））
- ユーザー所有データなので**解析キャッシュには置かない**（`data_dir`（`src-tauri/src/store.rs`））。
  `data_dir` 直下
- `save_labels` の失敗は warn のみで致命にしない（`save_overrides`（`src-tauri/src/lib.rs`）に倣う）
- **既存テストを1件も壊さない。** 特に `gated_non_funkot_skips_only_analysed_non_funkot`（`src-tauri/src/lib.rs`）と `bar_override_funkot_round_trip`（`src-tauri/src/store.rs`）

## 受け入れ条件

1. `cargo test --manifest-path src-tauri/Cargo.toml` が通る（既存テスト含む）
2. `set_label(path, Some(true))` 後、`labels.json` に verdict と時刻が入り、
   `library.json` の `BarOverride.funkot` にも `Some(true)` がミラーされる
3. `set_label(path, None)` で labels.json から消え、`BarOverride.funkot` も
   `None` に戻る。`BarOverride` が全項目 `None` になればエントリごと消える
   （`set_bars_impl`（`src-tauri/src/lib.rs`）の既存条件）
4. `set_folder_label` が対象曲数を正しく返す（サブディレクトリ再帰）
5. `label_stats().total` が 798 を返す
6. **「人が非Funkotと判定」と「未ラベル」が labels.json 上で区別できる**
7. アプリ再起動後もラベルが残る
8. 新規テスト: ラベルの round-trip、取り消し、ミラーの一致

## 検証コマンド

```bash
# funkot-player のリポジトリルートで実行
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

実機で `set_label` を呼んだあと:

```bash
# Windows 側 AppData の labels.json / library.json を確認
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — `labels.json` と `BarOverride.funkot` ミラー、コマンド3本をどう実現したか
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に round-trip・取り消し・ミラー一致の新規テスト
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — 実機での再起動残留など、確認できなかったもの

## 注意

- ラベル対象の同定は content hash 経由。`store::resolve_content_hash` と
  `hash-index.json` / `HASH_INDEX_FILE`（`src-tauri/src/store.rs`）が path→hash を橋渡しする
- `SAVE_LOCK` のロック順序（`SAVE_LOCK`（`src-tauri/src/lib.rs`）のコメント: `SAVE_LOCK` → queue →
  render）を守る

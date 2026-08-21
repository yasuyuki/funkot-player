# 05. ラベリング UI

**リポジトリ:** funkot-player / **依存:** 02（コマンド層）
**作業環境:** Windows デスクトップ

## 目的

798曲を通常の再生アプリ上で順に聴き、Funkot / 非Funkot を登録していけるように
する。進捗が見た目で分かること。

## 対象範囲

### (a) 登録 UI

ISSUES.md に既に設計意図がある — 「Non-Funkot を再生中であることを示すアイコンが
無い — `src/components/NowCard.svelte`。判定トグル兼用とし、押すと
Funkot↔Not Funkot を切り替える」。これに従う。

- `NowCard.svelte` に判定トグルを置く
- `AllTracks.svelte` の行にラベル列を追加
- パターンは `onChipPick`（`src/components/edit/AllTracks.svelte`）（楽観更新 → 成功したら
  トーストで取り消し可）を踏襲。`replaceLibraryRow`（`src/lib/state.svelte.ts`）の
  `#replaceLibraryRow(row)` を使えば Map の挿入順を保ったまま1行だけ差し替わる

### (b) フォルダ単位の一括ラベル

`AllTracks.svelte` にフォルダ見出し行を出し、そこから配下を一括ラベル
（02 の `set_folder_label`）。

**効きが大きい。** 126トップディレクトリに798曲＝平均6曲/dir で、Funkot は
コンピレーション単位でまとまっている。798判断が100程度まで落ちうる。

### (c) 再生順の可視化

現状の混乱の元:

- フォルダ巡回順 = `scan_tracks` の**絶対パスソート順**（`scan_tracks`（`src-tauri/src/lib.rs`））
- `libraryList`（`src/components/edit/AllTracks.svelte`）の表示順（`libraryList` の挿入順）は**これと一致する**
- しかし `sortKey`（`src/components/Library.svelte`）は**曲名順にソートしている**ため一致しない

やること:

- `DrainPolicy::ContinueFolder`（`src-tauri/src/queue.rs`） の `{ pos }` が真のカーソル。
  これを `QueueSnapshot` に露出する（バックエンド側の小さな追加）
- UI に **`412 / 798`** の形で現在位置と総数を出す
- ラベリング用の一覧を**巡回順**で描き、行に「現在位置 / ラベル済み / 再生済み」を出す

### (d) キーボードショートカット

現状**仕組みがゼロ**（`keydown` / `KeyboardEvent` のヒット0件）。
`App.svelte` の `$effect` で `window.addEventListener("keydown", ...)` を張り、
クリーンアップで外す（`onDocClick`（`src/components/OverflowMenu.svelte`）の既存パターン）。

| キー | 動作 |
|---|---|
| `F` | Funkot として登録し、次曲へ自動送り |
| `J` | non-Funkot として登録し、次曲へ自動送り |
| `Space` | 判断を保留して次曲へ |

**`Library.svelte` の検索ボックスにフォーカスがあるときは無効化すること。**

## 対象外

- 仮想リスト。798行は全部 DOM に出る。`rows`（`src/components/Library.svelte`）に
  「Fixed row height keeps a virtual-list swap possible later (YAGNI now)」の
  コメントがあり、必要になってからでよい
- Android のタッチ操作向け作り込み（今回は Windows デスクトップ）
- エクスポート（06）

## 制約・不変条件

- `tauri.ts` の interface は serde の snake_case を**同名で**ミラーする
  （`snake_case`（`src/lib/tauri.ts`）「ズレると silently undefined」）
- 楽観更新は失敗時に必ず元へ戻す
- CSS は `src/tokens.css` の既存トークンを使う。新しい色を勝手に足さない

## 受け入れ条件

1. `npm run build` が通る
2. `F` / `J` / `Space` を10回連打し、**押すたびに待ちなく次曲へ進む**
   （04 が入っていれば体感ゼロ。入っていなければ ~8s/曲 のままだが動作はする）
3. 検索ボックス入力中にショートカットが誤爆しない
4. 進捗表示が `10 / 798` を示し、曲が進むと増える
5. 一覧が**巡回順**で描かれ、現在位置・ラベル済み・再生済みが見て分かる
6. フォルダ一括ラベルが効き、対象曲数がトーストなどで返る
7. 取り消しができる
8. アプリ再起動後もラベルと進捗が残る

## 検証コマンド

```bash
# funkot-player のリポジトリルートで実行
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
./scripts/win-run.sh -ForceBuild
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 判定トグル、フォルダ一括、巡回順の進捗、ショートカットをどう実現したか
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に `F`/`J`/`Space` 連打と検索中の無効化
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — 実機確認の残り、02 未完了で動けなかった箇所

## この計画の完了後にやること（コード不要）

### 1. 作業前の設定確認

- **`⋮ 非Funkotも再生` を ON にする。** OFF だとフォルダ巡回が解析済み非Funkot を
  スキップし（`ALLOW_NON_FUNKOT` / `gated_non_funkot`（`src-tauri/src/lib.rs`））、**偽陰性＝最も確認したい曲が一度も
  再生されない**。これを忘れると798曲のパス全体が無効になる
- 01 が完了していることを確認（798曲の再解析が済んでいること）
- 再スキャンしたら**アプリを再起動する**。フォルダ巡回の曲リストは `start` 時点の
  スナップショット（`start_impl` / `scan_tracks`（`src-tauri/src/lib.rs`））

### 2. 自己一致率の測定（数十分）

**30曲をランダムに選んで2回ラベル付けし、自己一致率を測る。**
自己一致が9割なら、分類器がそれを超える精度を示しても意味が無い。
「目標の精度」が何を指しうるかがこれで決まる。**798曲パスに入る前に実施する。**

### 3. 798曲を聴く

終わったら 06 へ。

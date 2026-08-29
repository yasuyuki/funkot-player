# phase-01 first-seen index

## 目的

新着判定の土台を置く。hash index に first-seen marker と load provenance を持たせ、Settings に
arrivals baseline flag を足し、index / Settings の read-modify-write を直列化して原子的に保存する。
この phase では新着を**表に出さない**。

## 対象範囲

`README.md` の決定事項 2〜6・12〜14。

- hash index の load に provenance（Loaded / Missing / Corrupt）を持たせる
- Settings へ arrivals baseline flag を追加する（既定 false）
- hash index の entry へ first-seen marker を追加する
- content hash / library file の resolver に carry-forward を実装する
- scan に completeness を持たせ、不完全な scan では全体 prune を行わない
- baseline mode では scan 対象 entry の marker を全て None にする
- 専用の index lock を導入し、lock 順序 doc を更新する（保存 lock の doc comment と queue 側の
  lock 順序 doc の両方）
- hash index 保存と Settings 保存を原子化する（同一ディレクトリの tmp、失敗時 cleanup）
- 全 Settings read-modify-write を保存 lock で直列化する
- refresh と music dir 設定の lock 範囲、および music dir の実 path 比較

## 対象外

- 新着の抽出・fold・キュー投入（phase-02）
- UI・フロント（phase-03）
- **library row への first-seen フィールド追加**（決定事項 19 で禁止）
- 設定項目の追加（決定事項 16）

## 関連ファイルまたはサブシステム

- `src-tauri/src/store.rs` — Settings、hash index の entry と load / save、content hash と
  library file の resolver、stamping の純関数
- `src-tauri/src/queue.rs` — lock 順序 doc の追記のみ
- `src-tauri/src/lib.rs` — refresh、scan、music dir 設定、allow non funkot 設定、labeling mode
  設定、保存 lock の doc comment、新規の index lock

## 守るべき制約と不変条件

- 固定 lock 順序は index lock → 保存 lock → session → queue → render
- hash index の load 内部で lock を取らない。orchestration 層で取る
- baseline flag の true は complete scan と index 保存の**両方**が成功した後だけ保存する
- 保存失敗を warn-only にしない。I/O エラーを成功扱いにしない
- 「marker が None の entry を一括 stamp」は禁止
- incomplete な復旧 scan は再構築した index を保存しない
- folder picker を開いている間は lock を保持しない

## 受け入れ条件

`src-tauri` の test が通り、doc claim checker が通ること。

```
wsl.exe -d Ubuntu -u funkot-agent -e sh -lc 'cd /srv/funkot-agent/foundation-n-plus-17/funkot-player && ./dev.sh cargo test --manifest-path src-tauri/Cargo.toml && ./scripts/check-doc-claims.sh'
```

test には次を含める。

- 決定事項 2 の全分岐
- 正常な空 index を baseline した後、後日追加された 1 曲が新着として立つこと
- partial scan からの復旧時に偽 NEW が出ないこと
- hash 同一 / hash 変更 / legacy None の遷移
- refresh と allow non funkot の false 設定が競合しても最終値が baseline=true, allow=false
- refresh と labeling mode の true 設定が競合しても両方保持される
- 連続する allow setter の後、disk 上の値と静的フラグが一致する
- Settings の原子的保存中、reader は旧 JSON か新 JSON の完全な一方だけを読む
- baseline flag の保存に失敗したとき refresh が成功を返さない
- incomplete な復旧 scan は partial index を保存せず、次回の complete scan でも偽 NEW が出ない

## 必須の検証コマンド

受け入れ条件の 1 行と同じ。

## 実行ホストと起動ディレクトリ

WSL `Ubuntu`、user `funkot-agent`、起動ディレクトリ
`/srv/funkot-agent/foundation-n-plus-17/funkot-player`。

## 報告形式

変更したファイルと、受け入れ条件の 1 行の出力（test 件数と PASS / FAIL）を貼る。設計判断を
変えた場合はその理由を 1 段落で書く。実装に着手せず終える場合は残りを明示する。

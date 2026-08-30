# phase-03 new arrivals UI

**前提条件: phase-01 と phase-02 の受け入れ条件が通っていること。** 抽出 command、history
revision、キュー投入 command が無いと、この phase の表示と操作は成立しない。

## 目的

新着を常設バナー・行バッジ・新着のみフィルタで提示し、押下でまとめてキュー先頭へ入れる。
再生後は再スキャンなしに 3 つの表示が同時に消える。

## 対象範囲

`README.md` の決定事項 15・16・20。

- 型と wrapper の追加（`src/lib/tauri.ts`）
- 状態管理（`src/lib/state.svelte.ts`）— history revision をトリガにした pull、arrivals
  generation guard、fold 失敗時に revision を適用済みにせず再試行、stale response の破棄、
  キュー投入の呼び出し、queue refresh 後にバナー件数が減ること、music dir 設定後の refresh-owed
- reconciliation と 3 つの getter を**純粋な TS モジュールへ切り出す**（Svelte 側は薄く保つ）
- 常設バナーの component、NEW バッジ、新着のみフィルタ、トークン追加

## 対象外

- 自動キュー投入と設定項目（決定事項 16）
- スキャン完了時の新着トースト（トースト枠は 1 つしかない）
- library row への first-seen フィールド追加（決定事項 19 で禁止）
- **フロントの状態遷移テスト基盤（vitest 等）の導入。** 依存追加は設計エスカレーションなので
  この phase では決めない。必要と判断したら `designer` へ上げる

## 関連ファイルまたはサブシステム

- `src/lib/tauri.ts`、`src/lib/state.svelte.ts`
- 新規の純粋ロジックモジュール（`src/lib/` 配下）
- 新規のバナー component（`src/components/` 配下。体裁は既存の audition バナーが前例）
- `src/App.svelte`、`src/components/Library.svelte`、`src/tokens.css`

## 守るべき制約と不変条件

- getter は 3 本。バッジ・フィルタ用（gate 非依存）/ gate 適用 / gate 適用 ＋ 再生中・in-flight・
  reserved・pending 除外。バナーの操作件数は 3 番目。同じ除外集合を一括キュー投入 command も使う
- in-flight は engine へ渡した全曲を保持し、reserved は queue slot 更新から in-flight 保存までの
  短い間隙を補う。loader の多段先読みで reserved が進んでも、投入済み曲を再表示・重複追加しない
- pull のトリガは now playing ではなく history revision
- 自動 refresh は busy または error なら owed を維持し、成功した refresh だけが owed を解除する
- stale generation response を破棄しても owed は解除しない
- 新着の pull も成功まで processed revision と dirty 状態を進めない
- ボタンは無効化しない。未解析の新着を即キューへ入れると stalled になりうる事実は doc comment に
  残す

## 受け入れ条件

型検査と build が通り、doc claim checker が通ること。

```
wsl.exe -d Ubuntu -u funkot-agent -e sh -lc 'cd /srv/funkot-agent/foundation-n-plus-17/funkot-player && ./dev.sh npm test && ./dev.sh npm run check && ./dev.sh npm run build && ./scripts/check-doc-claims.sh'
```

受け入れ条件に「refresh が error で失敗した後も owed が残り、次の成功でのみ解除される」を含める。

**この phase は 1 行で判定できない手動確認を持つ。** 型検査と build は「再生後に 3 つの表示が
同時に消える」を証明できない。次を実行し、ログを報告に貼る。実行できない環境なら owner へ依頼して
結果を待つ。

```
wsl.exe -d Ubuntu -u funkot-agent -e sh -lc 'cd /srv/funkot-agent/foundation-n-plus-17/funkot-player && ./dev.sh npm run build && ./dev.sh cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol && GUI=1 ./dev.sh ./src-tauri/target/release/funkot-player'
```

1. 曲を 2 つ追加して再スキャン → バナーが 2 件
2. 1 曲を再生 → **再スキャンせずに**バッジ・フィルタ行・バナー件数が同時に 1 件へ減る
3. バナーを押す → 押下後にバナー件数が 0 になる

## 必須の検証コマンド

受け入れ条件の 2 つのブロック（自動の 1 行と、手動確認の起動 1 行）。

## 実行ホストと起動ディレクトリ

WSL `Ubuntu`、user `funkot-agent`、起動ディレクトリ
`/srv/funkot-agent/foundation-n-plus-17/funkot-player`。

## 報告形式

変更したファイルと、自動の 1 行の出力を貼る。手動確認は 3 項目それぞれの観測結果を書く。
owner へ依頼した場合はその旨と、受け取った結果を貼る。

# phase-02 queue new tracks

**前提条件: phase-01 の受け入れ条件が通っていること。** first-seen marker、provenance、baseline
flag、index lock、原子的保存が無いと、この phase の抽出と fold は成立しない。

## 目的

新着を抽出し、再生済みを個別に消し込み、明示操作でキュー先頭へまとめて入れる server 側を作る。
UI は作らない。

## 対象範囲

`README.md` の決定事項 1・7〜11・17〜19。

- 新着抽出の純関数（committed index だけを正本にする）
- 新着一覧を返す command（戻り型を明示。path と first-seen の組の配列）
- history に hash がある entry だけを個別に None へ fold し、失敗時は失敗を返す
- 履歴消去 command の事前 fold と、index 保存成功時だけ history を消す順序
- history revision の導入と player state への追加
- queue へ順序を保って先頭挿入する関数（判定と挿入を一つの queue lock 内で行い実追加数を返す）
- 新着をキューへ入れる command と handler 登録
- queue 永続化を全 guard 解放後に呼ぶこと

## 対象外

- UI・フロント（phase-03）
- 自動キュー投入（決定事項 16 により明示操作のみ）
- library row への first-seen フィールド追加（決定事項 19 で禁止）

## 関連ファイルまたはサブシステム

- `src-tauri/src/store.rs` — 抽出と fold の純関数
- `src-tauri/src/queue.rs` — 先頭挿入の新規関数
- `src-tauri/src/lib.rs` — 再生記録、履歴消去、player state、history revision、新着一覧 command、
  キュー投入 command、handler 登録

## 守るべき制約と不変条件

- 順序不変条件は reserved があればその後ろに新着候補、その後ろに既存 pending。reserved に触れない
- 新着候補の順序は first-seen 昇順、同時刻は path 順
- 再生中の曲もサーバ側候補から除外する
- gate は enqueue と同じ allow non funkot
- **queue 永続化を index lock / 保存 lock / queue guard を保持したまま呼ばない**（Rust の Mutex は
  再入不可で deadlock する）
- fold の保存失敗を warn-only にしない
- index 保存に失敗したまま history を先に消さない
- pull が読むのは app-data の 3 つの JSON だけで、Music ファイル I/O を行わない

## 受け入れ条件

`src-tauri` の test が通り、doc claim checker が通ること。

```
wsl.exe -d Ubuntu -u funkot-agent -e sh -lc 'cd /srv/funkot-agent/foundation-n-plus-17/funkot-player && ./dev.sh cargo test --manifest-path src-tauri/Cargo.toml && ./scripts/check-doc-claims.sh'
```

test には次を含める。

- 先頭挿入の順序（first-seen 昇順 → path 順）
- reserved の有無による挿入位置
- gate による除外
- 同一 hash の扱い
- 再生中 / reserved / pending の除外
- 再実行の冪等性
- 新着 A / B のうち A だけ再生した後に履歴消去した場合の状態遷移
- revision の pull を実行しないまま履歴消去しても再生済み A が復活しないこと
- index 保存に失敗したとき history を消さないこと
- history revision が増える箇所
- キュー投入 command が queue 永続化を全 guard 解放後に呼ぶこと（保存 lock の再入が無いこと）

## 必須の検証コマンド

受け入れ条件の 1 行と同じ。

## 実行ホストと起動ディレクトリ

WSL `Ubuntu`、user `funkot-agent`、起動ディレクトリ
`/srv/funkot-agent/foundation-n-plus-17/funkot-player`。

## 報告形式

変更したファイルと、受け入れ条件の 1 行の出力（test 件数と PASS / FAIL）を貼る。lock 順序に
関わる変更をしたなら、どの guard をいつ解放するかを 1 段落で書く。

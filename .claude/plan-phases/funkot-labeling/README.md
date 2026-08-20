# Funkot 判定の精度向上 — 分割計画インデックス

## なぜやるか

`da8b390` で Funkot / 非 Funkot の判定とゲートを入れたが、しきい値調整を1回しか
行っておらず目標精度に届いていない。原因は**正解データが無いこと**。

現状の「正解」である `funkot-autodj-for-ui/testdata/classify_*.txt`（393件）は
仮実装の出力であり、正確でも完全でもない。`CHANGELOG` の「69/69・60/63・
偽陽性 20/261」はこの corpus を正解として測った数字なので、**精度評価が循環して
いる**。しきい値をどう動かしても改善したか判定できない。

手持ちライブラリ **798曲**（`/mnt/oldpc/music`、126トップディレクトリ）を人が
聴いてラベル付けし、正解データにする。作業は Windows デスクトップの通常再生
アプリ上で行う。

```
798曲を人が聴く → labels.json（正解データ）
                    ├→ classify_*.txt を再生成 → 旧 corpus と diff = 仮実装の誤りの所在
                    └→ キャッシュ済みスコアと突合 → しきい値を掃引して調整
```

**ラベルを集めるだけでは精度は上がらない。** スコアとラベルが揃って初めて
しきい値を動かせる。現状 `is_funkot` は bool のみでスコアは捨てられている
（`funkot-core/src/lib.rs:159` 『the scores themselves are not stored』）。

## フェーズ

01〜04 は互いに独立で、どの順でも着手できる。

| # | ファイル | 内容 | リポジトリ | 依存 | 状態 |
|---|---|---|---|---|---|
| 01 | [phase-01-classify-scores.md](phase-01-classify-scores.md) | 判定スコアの保存 | funkot-autodj-for-ui | — | 完了 |
| 02 | [phase-02-label-store.md](phase-02-label-store.md) | ラベル永続化とコマンド層 | funkot-player | — | 完了 |
| 03 | [phase-03-play-history.md](phase-03-play-history.md) | 再生履歴 | funkot-player | — | 完了 |
| 04 | [phase-04-labeling-mode.md](phase-04-labeling-mode.md) | ラベリングモード（head のみ伸長） | 両方 | — | 実機確認済み（OFF不変・ON10連打ゼロ待ち）。両リポジトリ未コミット |
| 05 | [phase-05-labeling-ui.md](phase-05-labeling-ui.md) | ラベリング UI | funkot-player | 02 | 完了 |
| 05a | [phase-05a-cursor-phase-rule.md](phase-05a-cursor-phase-rule.md) | Cursor で phase を実行できるようにする | ワークスペースルート | — | 未着手 |
| 05b | [phase-05b-baseline-freeze.md](phase-05b-baseline-freeze.md) | 削除前に基準値を凍結する | funkot-autodj-for-ui | — | 未着手 |
| 05c | [phase-05c-test-residue-purge.md](phase-05c-test-residue-purge.md) | テスト残骸の一掃と再解析 | 両方 | **05b** | 未着手 |
| 05d | [phase-05d-agreement-harness.md](phase-05d-agreement-harness.md) | 自己一致率 30曲×2 の道具立て | funkot-player | — | 未着手 |
| 05e | [phase-05e-plan-facts-sync.md](phase-05e-plan-facts-sync.md) | 計画文書を実測へ合わせる | 両方 | — | 未着手 |
| 06 | [phase-06-export-and-tuning.md](phase-06-export-and-tuning.md) | エクスポート・突合・しきい値調整 | 両方 | 01, 02, 05, 05a–05e | 未着手 |

## 05a–05e — 人手パスを始める前の準備

05 まででコードは揃った。**残っているのは人が798曲を聴く作業**だが、その前に
どのフェーズにも属さない準備が要る。実機テストが残した状態の除去、自己一致率を
測る道具、そして計画文書に書かれた前提のうち実測と食い違うものの訂正。

順序の制約は **05b → 05c** の1つだけ。他は互いに独立で、どの順でも着手できる。

**旧 corpus 393件（`funkot-autodj-for-ui/testdata/classify_*.txt`）は動作テストの
過程で作られたもので、内容が誤っている。流用しない。** これは phase-06 の
「旧 corpus との突合」が成立しないことを意味する（05e で記述を落とす）。

## 順序の制約（1つだけ、しかし重要）

**01 は 05 の完了（＝798曲を聴き始める前）までに終わらせる。**

01 は `CACHE_VERSION` 13→14 を伴い、798曲の全再解析が走る。ラベリングを先に
済ませてから 01 をやると、同じ798曲の再デコード・再解析をもう一度払うことになる。
どうせ1回は回すので、その回に相乗りさせる。

```
01 スコア保存 ─┐
02 ラベル永続化 ├→ 05 UI ─→ [ 798曲を聴く ] ─→ 06 突合・調整
03 履歴        │
04 ラベリングモード ┘
```

## 聴き始める前にやる測定（コード不要・数十分）

**30曲をランダムに選んで2回ラベル付けし、自己一致率を測る。** 自己一致が9割なら、
分類器がそれを超える精度を示しても意味が無い。「目標の精度」が何を指しうるかが
これで決まる。05 完了直後、798曲パスに入る前に実施する。

## 全計画に共通する注意

1. **`allow_non_funkot` を ON にしないとラベリングは成立しない。** OFF だと
   フォルダ巡回が解析済み非Funkot をスキップする（`lib.rs:2394-2399`）ため、
   **偽陰性＝最も確認したい曲が一度も再生されない**
2. **フォルダ巡回の曲リストは `start` 時点のスナップショット**
   （`lib.rs:3076` → `lib.rs:3168`）。再スキャンしても切り替わらず、再起動が要る
3. `MIN_DURATION_SECS = 30.0`（`analysis.rs:46`）未満は解析がエラーになり、
   未解析扱いでゲートも掛からずスコアも出ない。手動ラベルは付くがしきい値調整
   には使えない。ISSUES.md に既出
4. player が参照する funkot-core は **`funkot-autodj-for-ui` 側**
   （`funkot-player/src-tauri/Cargo.toml:47` の path 依存）。`funkot-autodj` 本体ではない
5. `/mnt/oldpc/music` は WSL 再起動でマウントが外れる。作業開始時に `oldpc-music`

## 調査で確定した事実（再調査不要）

- ライブラリ実数: **798** 音声ファイル、126トップディレクトリ
- 旧 corpus 393件のパスは**全て現存**（diff 可能）
- 解析は既に前倒し済み（`spawn_analysis_worker` `lib.rs:5203`）。
  **初期解析へ回せる処理はもう残っていない**
- 「次の曲」待ちの正体は全曲タイムストレッチ **約8秒/曲**（`engine.rs:2070`）。
  音声なので JSON キャッシュには載らない
- 判定ロジックは `classify_is_funkot`（`funkot-core/src/analysis.rs:1380`）、
  しきい値は `analysis.rs:63,68,74`
- `BarOverride.funkot`（`store.rs:363`）は読み取り経路が完成済み・書き込み経路のみ不在

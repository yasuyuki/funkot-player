# 計画文書の主張が腐るのを止める — 分割計画インデックス

## なぜやるか

`funkot-labeling` の準備フェーズ5本を定義するだけで、約40回の読み取りと
プラン全体の書き直し1回を要した。原因は調べ方ではなく、
**文書が検証されない主張を蓄えていて、しかも読む側に検証を禁じていた**ことにある。

`funkot-labeling/README.md` の `## 調査で確定した事実（再調査不要）` 節を実測した結果:

| 記載 | 実測 | ずれ |
|---|---|---|
| `allow_non_funkot` スキップ = `lib.rs` の 2394-2399 行 | 2519-2522 行 | 2394 行付近は無関係なイベント破棄コード |
| `spawn_analysis_worker` = `lib.rs` の 5203 行 | 6097 行 | **894行** |
| `gated_non_funkot` = `lib.rs` の 4362-4380 行 | 4553 行 | 191行 |
| `BarOverride.funkot` = `store.rs` の 363 行 | 381 行 | 18行 |
| `classify_is_funkot` = `analysis.rs` の 1380 行 | 1382 行 | 2行 |
| しきい値3定数 = `analysis.rs` の 63, 68, 74 行 | 64, 69, 74 行 | 1行 |
| `MIN_DURATION_SECS` = `analysis.rs` の 46 行 | 47 行 | 1行 |
| 126トップディレクトリ | **103** | — |
| 旧 corpus 393件は「全て現存（diff 可能）」 | パスは解決するが**内容が誤り** | — |

1つ目は「`allow_non_funkot` を ON にしないと798曲パス全体が無効になる」という
**この計画で最も重い主張の根拠**として3つの文書に出てくる。そして
`phase-05c-test-residue-purge.md` を書いたとき、それを検証せずそのまま写した。
**同じ失敗が1ターンのうちに再生産されている。** 人の注意力では止まらない。

このリポジトリには既に正しい型がある — `check_jni_keep_rules`
（`scripts/check-release-invariants.sh`）の POLICY コメント:

> a rule that lives only in a code comment gets skipped by the next person who
> adds a class; one that lives here cannot be.

**同じ規律を計画文書へ適用する。**

## 中心となる判断

**行番号引用をやめる。** 検査で維持するのではなく、腐るフィールドを消す。

- docs には `` `symbol`（`path`） `` だけを書く
- 検査は「行番号形式が混入していないか」と「シンボルがそのファイルに実在するか」を見る
- **書けないものは腐らない。** 94件の引用が94個の潜在的な嘘でなくなる

会話出力で `file:line` を使う慣習とは別。**寿命が違う。** チャットは1ターンで
消えるが、計画文書はコードが894行動いても残る。

## フェーズ

| # | ファイル | 内容 | 依存 | 状態 |
|---|---|---|---|---|
| 01 | [phase-01-doc-claim-checker.md](phase-01-doc-claim-checker.md) | 検査を先に置く | — | 完了 |
| 02 | [phase-02-line-citation-purge.md](phase-02-line-citation-purge.md) | 94件の引用を変換する | 01 | 完了 |
| 03 | [phase-03-labeling-facts-script.md](phase-03-labeling-facts-script.md) | 事実を1箇所から出す | — | 完了 |
| 04 | [phase-04-facts-single-source.md](phase-04-facts-single-source.md) | 「再調査不要」を消す | 02, 03 | 未着手 |

01 → 02 と、02・03 → 04 の順序制約がある。01 と 03 は互いに独立。

## funkot-labeling との関係

**この計画の 01–04 を `funkot-labeling` の 05b–05e より先に実行する。**

`phase-05e-plan-facts-sync.md` は「126 を 103 に直す」と書いてあるが、
04 はその数字を文書から**消す**。順序が逆だと二度手間になる。
04 の対象範囲に 05e の改訂が入っている。

`phase-05a-cursor-phase-rule.md` は独立でいつでもよい。

## 時間を消費した構造（5つ）

| # | 構造 | 代償 | 扱い |
|---|---|---|---|
| 1 | セッションが作業ツリーの外（Windows `work`）から始まり、紛らわしい checkout が5つある | 場所探しに約13 call | **仕組みにしない。** Explore の限定解禁とメモリで閉じる |
| 2 | 状態の記録が3系統（README のフェーズ表 / gitignored な HANDOFF / 実際の git ref）あり、どれも権威でなく別方向に古い | 照合に約8 call | 04 で縮む（git から導出できるものを転記しない） |
| 3 | **「再調査不要」と宣言された節が最も腐っている** | 誤った根拠を新ファイルへ伝播 | 01, 02, 04 |
| 4 | 機械が答えられる事実を毎回その場の書き捨てスクリプトで再導出する | 約8 call、うち2回は空振り | 03 |
| 5 | 誤りと分かったデータが正解データの名前と場所のまま置かれている | プラン全面書き直し | `funkot-labeling/phase-05c` が削除。03 が再発を検知 |

## 仕組みにしないもの

- **構造1に新しい常時ルールを足さない。** Windows 側 `~/.claude/rules/` に6本目を
  足すと、慣習上 Cursor / Codex への同時展開が要る。得るものに対して高い
- **事実スクリプトを CI に載せない。** ユーザーの実データと音楽共有が要る
- **既存 `docs/` への適用は今回やらない。** 問題が実際に起きた `plan-phases/` 配下に
  限る。広げるのは検査対象パスの1行

# 04. 「再調査不要」を消す

**リポジトリ:** funkot-player / **依存:** 02（引用の変換）、03（事実スクリプト）

## 目的

測定できる数字を文書から取り除き、出どころを1つにする。

`funkot-labeling/README.md` の見出し `## 調査で確定した事実（再調査不要）` は、
この計画で直している問題の実体そのもの — **読む側に検証を禁じておいて、
真であり続ける仕組みが無い。** 実測すると9項目中8項目が腐っていた。

書いた時点では正しかった。腐ったのは、更新の仕組みが無いのに「確定」と
宣言したから。**宣言をやめる。**

## 対象範囲

### (a) `funkot-labeling/README.md` — 「再調査不要」節の削除

`## 調査で確定した事実（再調査不要）` 節を**削除**し、
`./scripts/labeling-facts.sh` を実行せよという1段落に置き換える。

ただし同節の項目のうち**測定値でないもの**は設計上の観察なので残す。
別の見出し（`## 設計上の観察` など。「再調査不要」とは書かない）へ移す:

- 解析は既に前倒し済み（`spawn_analysis_worker`）。初期解析へ回せる処理は残っていない
- 「次の曲」待ちの正体は全曲タイムストレッチ 約8秒/曲。音声なので JSON キャッシュに
  載らない
- `BarOverride` の `funkot` は読み取り経路が完成済み・書き込み経路のみ不在

**削除するのは測定値**（798 / 126 / 393件のパス現存）。引用の行番号は 02 で処理済み。

### (b) フェーズ表の `状態` 列

`未着手` / `実行中` / `完了` のみとし、**commit 状態を書かない**。

現在 04 の行に「両リポジトリ未コミット」とあるが、これは git から導出できる。
転記した瞬間に古くなる（実際、その commit は既に存在している）。
構造2（状態の記録が3系統あってどれも権威でない）の縮小。

### (c) `funkot-labeling/phase-05b` / `phase-05c` の検証コマンド

手書きの `grep -lE ... | wc -l` 群を `./scripts/labeling-facts.sh` の呼び出しへ置換する。

同じ問いを5ファイルで別々の grep が答えている状態は、構造4そのもの。
**ただし各フェーズ固有の検査**（05b の TSV 行数、05c の `diff` による決定性確認、
`C:\funkot-test` の不在）は残す。置換するのはキャッシュ・設定・ラベルの状態確認だけ。

### (d) `funkot-labeling/phase-05e` の対象範囲の改訂

05e は現在「126 → 103 に直す」「30秒未満0曲を追記」「412 を明記」と書いてあるが、
**04 はその数字を文書から消す**。順序が逆だと二度手間になる。

05e から削除する項目:

- `README.md` の「トップディレクトリ 126→103」
- `README.md` の「30秒未満0曲」
- `phase-06` の「突合の基準値として `is_funkot: true` 412/798 を明記」

05e に残すもの（散文と範囲の訂正）:

- 旧 corpus を流用しない旨と、phase-06 対象範囲 (b) の削除
- `MIN_DURATION_SECS` 除外が**このライブラリでは発生しない**という記述
  （件数ではなく事実として。件数はスクリプトが出す）
- パス変換の実体、`testdata/` が gitignored である理由の訂正
- (d) の「循環している」→「誤ったデータから出ている」
- `classify_probe` の doc コメント、`HANDOFF.md`

**05e の受け入れ条件から `126` と `412` を見る行を削除する**（そうしないと
05e が 04 を打ち消す）。

### (e) `funkot-labeling/README.md` に順序を明記

`doc-claim-checks` の 01–04 を 05b–05e より先に実行すること。

## 対象外

- `funkot-labeling/phase-05e` の実行そのもの。**書き換えるのは範囲の定義だけ**
- 完了済みフェーズ（01–05）の内容変更。引用の形は 02 で処理済み
- `docs/` 配下
- `HANDOFF.md`（05e が扱う。local-data 配下なので commit しない）

## 関連ファイル

| パス | 役割 |
|---|---|
| `.claude/plan-phases/funkot-labeling/README.md` | (a)(b)(e) |
| `.claude/plan-phases/funkot-labeling/phase-05b-baseline-freeze.md` | (c) |
| `.claude/plan-phases/funkot-labeling/phase-05c-test-residue-purge.md` | (c) |
| `.claude/plan-phases/funkot-labeling/phase-05e-plan-facts-sync.md` | (d) |
| `scripts/labeling-facts.sh` | 置換先。03 で作る |

## 制約・不変条件

- **数字を1つも文書へ書き戻さない。** 例外を作ると出どころが2つに戻る
- 05b / 05c の**フェーズ固有の検査は残す**。消すのは汎用の状態確認だけ
- 05e の改訂は**範囲の削除のみ**。残る項目の文言を変えない
- フェーズ表の列構成を変えない
- `./scripts/check-doc-claims.sh` が引き続き exit 0

## 受け入れ条件

1. `funkot-labeling/README.md` に `再調査不要` の語が無い
2. 同ファイルに `126` / `798` / `393` の数字が無い
   （`funkot-labeling` の説明文として曲数に触れる場合は
   `./scripts/labeling-facts.sh` を参照させる）
3. 設計上の観察3項目が別見出しの下に残っている
4. フェーズ表の `状態` 列が `未着手` / `実行中` / `完了` のみ
5. `phase-05b` / `phase-05c` の検証コマンドが `labeling-facts.sh` を呼んでおり、
   フェーズ固有の検査は残っている
6. `phase-05e` の対象範囲から数字の更新3項目が消え、受け入れ条件から
   `126` / `412` を見る行が消えている
7. `funkot-labeling/README.md` に実行順序（doc-claim-checks が先）が書かれている
8. `./scripts/check-doc-claims.sh` が exit 0
9. `./scripts/labeling-facts.sh` が exit 0

## 検証コマンド

```bash
cd <workspace-root>/funkot-player
P=.claude/plan-phases/funkot-labeling

grep -c '再調査不要' $P/README.md                    # 0
grep -oE '\b(126|798|393)\b' $P/README.md | wc -l    # 0
grep -c 'labeling-facts.sh' $P/phase-05b-baseline-freeze.md $P/phase-05c-test-residue-purge.md
grep -oE '\b(126|412)\b' $P/phase-05e-plan-facts-sync.md | wc -l   # 0
grep -c 'doc-claim-checks' $P/README.md              # 1 以上

./scripts/check-doc-claims.sh; echo "exit=$?"        # 0
./scripts/labeling-facts.sh;   echo "exit=$?"        # 0

git status --short
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 削除した節、移した観察、置換した検証コマンド、
   05e から外した項目
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に受け入れ条件1・2・6
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — 数字を消したことで読みにくくなった箇所、
   スクリプトを走らせないと分からなくなった前提

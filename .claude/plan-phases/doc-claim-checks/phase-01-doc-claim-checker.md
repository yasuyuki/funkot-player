# 01. 検査を先に置く

**リポジトリ:** funkot-player / **依存:** なし
**後続の制約:** 02 はこの検査を通すことが受け入れ条件になる

## 目的

計画文書の引用が腐っていることを、人の注意力ではなくスクリプトで検出する。

**このフェーズの完了時点で検査は落ちる。** 94件の行番号引用がまだ残っているため。
落ちる状態を先に作るのが目的で、直すのは 02。

## 対象範囲

`funkot-player/scripts/check-doc-claims.sh` を新規追加する。
`scripts/check-release-invariants.sh` と**同じ形**にそろえる:

- POSIX sh、`set -eu`、`cd "$(dirname "$0")/.."`
- 検査は `check_*` 関数。末尾のリストから呼び、`status=1` を集約して `exit "$status"`
- 失敗時は「何が」「どこで」「なぜまずいか」を `>&2` に出す
- 依存を足さない（Docker もツールチェインも要らない。それが毎回走らせられる理由）
- **POLICY コメント**を冒頭に置く。`check-release-invariants.sh` と同じ趣旨:
  「文書の主張が腐って誤った根拠を伝播させたら、直すだけでなくここに検査を足す。
  コメントに書いた規則は次の人に飛ばされるが、ここにある規則は飛ばせない」

検査対象は `.claude/plan-phases/**/*.md` **のみ**。

### `check_no_line_citations`

`path:NNN` / `path:NNN-MMM` 形式の引用が1件も無いこと。
拡張子は `.rs` `.ts` `.svelte` `.toml` `.sh` `.py` `.json` `.md` と `.gitignore`。

失敗時は該当ファイルと行を列挙する。**件数だけ出して終わらない。**

行番号は腐るフィールドであり、書けなくすることが対策そのもの
（README「中心となる判断」）。

### `check_symbols_resolve`

`` `symbol`（`path`） `` の形の引用について:

1. `path` が実在する
2. そのファイルが `symbol` を含む

`symbol` は Rust の識別子・型名・定数名、あるいはファイル名。
**正規表現で抽出できる形に限る。** 抽出できない書き方をした引用は
「検査されていない引用」なので、それ自体を報告する。

### CI の制約（黙って弱くしないこと）

`.github/workflows/checks.yml` の `invariants` ジョブは sibling checkout をしない
（ジョブ内コメントが「builds nothing なので funkot-core もツールチェインも要らない」と
明示している）。したがって `funkot-autodj-for-ui/...` や `funkot-core/...` への引用は
**CI では解決できない**。

- CI では形式検査（`check_no_line_citations`）のみ完全に効く
- シンボル解決できなかった件数を**必ず印字する**。
  「N件は sibling repo のため解決を遅延した」と出す
- ローカル実行時（ワークスペースルートから sibling が見えるとき）は解決する

**遅延を黙って通さない。** 検査が静かに弱くなるのは、この計画が直している失敗そのもの。

### CI への追加

`.github/workflows/checks.yml` に3つ目のステップとして追加する。
既存2ステップ（`check-release-invariants.sh` と `set-version.sh --check`）と
同じ形。ジョブを増やさない。ツールチェインを要求しない。

## 対象外

- 94件の引用の変換（02）
- `docs/` 配下や `README.md`（リポジトリルート）への適用。
  `plan-phases/` 配下に限る
- `labeling-facts.sh`（03）
- 既存 `check-release-invariants.sh` / `set-version.sh` の変更

## 関連ファイル

| パス | 役割 |
|---|---|
| `scripts/check-release-invariants.sh` | 形・POLICY コメント・出力の書き方の手本 |
| `scripts/set-version.sh` | `--check` の作法（同じスクリプトを人と CI が走らせる） |
| `.github/workflows/checks.yml` | 追加先。`invariants` ジョブ |
| `.claude/plan-phases/` | 検査対象 |

## 制約・不変条件

- **依存を足さない。** POSIX sh のみ。`jq` も Python も使わない
- 既存の2検査を壊さない
- `invariants` ジョブにビルドを持ち込まない
  （ジョブ内コメント: 「Android SDK が要るようになった瞬間、毎 push に走るには
  高くなりすぎ、tag 限定に落とされる。リリース専用不変条件にはそれでは遅い」）
- **この phase ファイル自身も検査を通ること。** 腐りの実例を書くときは
  `lib.rs` の 2394 行 のように書き、`path:NNN` 形式にしない

## 受け入れ条件

1. `scripts/check-doc-claims.sh` が存在し、実行ビットが立っている
2. 冒頭に POLICY コメントがある
3. `check_no_line_citations` と `check_symbols_resolve` の2関数がある
4. **いま実行すると exit 非0**（94件の引用が残っているため）。
   失敗出力に該当ファイルと行が列挙される
5. sibling repo のために解決を遅延した件数が印字される
6. `.github/workflows/checks.yml` に3つ目のステップがある
7. `./scripts/check-release-invariants.sh` と `./scripts/set-version.sh --check` が
   引き続き通る

## 検証コマンド

```bash
cd <workspace-root>/funkot-player

test -x scripts/check-doc-claims.sh && echo EXECUTABLE
grep -c 'POLICY' scripts/check-doc-claims.sh
grep -c '^check_no_line_citations\|^check_symbols_resolve' scripts/check-doc-claims.sh

./scripts/check-doc-claims.sh; echo "exit=$?"     # 非0。列挙が出ること

grep -c 'check-doc-claims' .github/workflows/checks.yml

./scripts/check-release-invariants.sh
./scripts/set-version.sh --check
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 2つの検査の判定方法、抽出に使った正規表現、
   sibling 解決の遅延をどう可視化したか
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に受け入れ条件4の失敗出力と遅延件数
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）。
   「シンボル」の定義を含む
6. **未解決事項と残存リスク** — 抽出できなかった引用の形、CI で検査されない範囲

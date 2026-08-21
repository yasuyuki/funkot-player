# 02. 94件の引用を変換する

**リポジトリ:** funkot-player / **依存:** 01（検査が存在すること）

## 目的

`.claude/plan-phases/` 配下の行番号引用を、腐らない形へ変換する。
受け入れ条件は機械的 — `./scripts/check-doc-claims.sh` が exit 0。

## 対象範囲

`funkot-labeling` 配下9ファイル、計94件（ユニーク71件）:

| ファイル | 件数 |
|---|---|
| `phase-02-label-store.md` | 21 |
| `phase-04-labeling-mode.md` | 17 |
| `phase-05-labeling-ui.md` | 12 |
| `README.md` | 11 |
| `phase-01-classify-scores.md` | 11 |
| `phase-05c-test-residue-purge.md` | 7 |
| `phase-03-play-history.md` | 5 |
| `phase-05d-agreement-harness.md` | 5 |
| `phase-06-export-and-tuning.md` | 5 |

### 変換規則

**(a) シンボル付き** — `` `symbol`（`path` の NNN 行） `` の形になっているもの:

行番号を落とすだけ。`` `symbol`（`path`） ``。機械的で判断を要さない。

**(b) 裸の行番号** — シンボルが書かれていないもの:

**現在のコードでその行に何があるかを見て**、シンボル名を与える。
`grep -n` で確認してから書く。**推測で書かない。**

**(c) 解決できないもの** — その行に意味のあるものが無い（＝引用が腐っている）:

**勝手に発明しない。** 何を指していたつもりかを周囲の文脈から推定し、
候補があれば書き、無ければ報告に列挙してリードへ返す。

### 既知の腐り（`grep -n` で確認済み。ここで直る）

| 記載 | 実際の位置 | 与えるシンボル |
|---|---|---|
| `lib.rs` の 2394-2399 行（`allow_non_funkot` スキップ） | 2519-2522 行 | `` `ALLOW_NON_FUNKOT` / `gated_non_funkot`（`src-tauri/src/lib.rs`） `` |
| `lib.rs` の 4362-4380 行（`gated_non_funkot`） | 4553 行 | `` `gated_non_funkot`（`src-tauri/src/lib.rs`） `` |
| `lib.rs` の 5203 行（`spawn_analysis_worker`） | 6097 行 | `` `spawn_analysis_worker`（`src-tauri/src/lib.rs`） `` |
| `store.rs` の 363 行（`BarOverride.funkot`） | 381 行 | `` `BarOverride::funkot`（`src-tauri/src/store.rs`） `` |
| `analysis.rs` の 1380 行（`classify_is_funkot`） | 1382 行 | `` `classify_is_funkot`（`funkot-core/src/analysis.rs`） `` |
| `analysis.rs` の 63, 68, 74 行（しきい値3定数） | 64, 69, 74 行 | `` `CLASSIFY_MIN_Z` / `CLASSIFY_MIN_Z_RATIO` / `CLASSIFY_MAX_HALF_RATIO`（`funkot-core/src/analysis.rs`） `` |
| `analysis.rs` の 46 行（`MIN_DURATION_SECS`） | 47 行 | `` `MIN_DURATION_SECS`（`funkot-core/src/analysis.rs`） `` |
| `engine.rs` の 2070 行（タイムストレッチ 約8秒/曲） | 未確認 | 確認して与える。無ければ (c) 扱い |

**1つ目が最重要。** 「`allow_non_funkot` を ON にしないと798曲パス全体が無効になる」
という主張の根拠であり、3つの文書に出てくる。

## 対象外

- 記述内容の修正。**引用の形だけ**を変える。散文の訂正は
  `funkot-labeling/phase-05e-plan-facts-sync.md`、数字の削除は 04
- `docs/` 配下やリポジトリルートの `README.md`
- コードの変更
- 完了済みフェーズ（01–05）の除外。**例外を作らない。**
  例外は検査が死ぬ道筋であり、いま直しているのはまさにそれ

## 関連ファイル

| パス | 役割 |
|---|---|
| `.claude/plan-phases/funkot-labeling/*.md` | 変換対象9ファイル |
| `scripts/check-doc-claims.sh` | 受け入れ判定 |
| `src-tauri/src/lib.rs`, `src-tauri/src/store.rs` | シンボル確認先（funkot-player 側） |
| `funkot-core/src/analysis.rs`, `funkot-core/src/engine.rs` | 同（funkot-autodj-for-ui 側） |

## 制約・不変条件

- **引用の形だけを変える。** 前後の文の意味を変えない
- シンボルは `grep -n` で実在を確認してから書く。**推測で書かない**
- 変換後のシンボル名は、そのファイルに**実際に現れる文字列**にする
  （`BarOverride::funkot` と書くなら、その綴りが検査を通ること。
  通らないなら `funkot`（フィールド名）と `BarOverride`（型名）に分ける）
- パスはワークスペースルート相対か、リポジトリ相対かを**文書内で統一する**
- 完了済みフェーズの内容は書き換えない。引用の形のみ

## 受け入れ条件

1. `./scripts/check-doc-claims.sh` が **exit 0**
2. `.claude/plan-phases/` 配下に行番号引用が **0件**
3. 上表の既知の腐り8件すべてが、確認済みシンボルに置き換わっている
4. 解決できなかった引用が報告に**全件列挙**されている（0件ならその旨）
5. `git diff` が `.claude/plan-phases/` 配下の `.md` のみに閉じている
6. 各ファイルの散文が変わっていない（`git diff --word-diff` で引用部分のみが動く）

## 検証コマンド

```bash
cd <workspace-root>/funkot-player

./scripts/check-doc-claims.sh; echo "exit=$?"     # 0

grep -rohE "[A-Za-z0-9_./-]+\.(rs|ts|svelte|toml|sh|py|json):[0-9]+" .claude/plan-phases/ | wc -l   # 0

# 既知の腐りが消えていること
grep -rn "2394\|5203\|4362\|4380" .claude/plan-phases/ | grep -v doc-claim-checks | wc -l   # 0

# 与えたシンボルが実在すること（例）
grep -c "fn gated_non_funkot" src-tauri/src/lib.rs
grep -c "fn spawn_analysis_worker" src-tauri/src/lib.rs
grep -c "MIN_DURATION_SECS" ../funkot-autodj-for-ui/funkot-core/src/analysis.rs

git status --short
git diff --stat
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何件変換したか1行ずつ
2. **実装内容** — (a)(b)(c) それぞれの件数。(b) でシンボルを与えた根拠
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に `exit=0` と引用0件
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — **(c) に落ちた引用を全件列挙する。**
   腐っていた引用が指していたはずのものが分からないなら、それは
   計画の前提が1つ失われたということなので、必ずリードへ返す

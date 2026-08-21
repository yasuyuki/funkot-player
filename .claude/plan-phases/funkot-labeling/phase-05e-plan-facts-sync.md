# 05e. 計画文書を実測へ合わせる

**リポジトリ:** funkot-player + funkot-autodj-for-ui / **依存:** なし
**時期:** **人が798曲を聴き始める前に終わらせる**

## 目的

計画文書に書かれた前提のうち、実測と食い違うものを直す。

聴き終えてから前提が違うと分かるのが一番高くつく。特に「旧 corpus との突合」は
phase-06 の対象範囲の1/4を占めており、**その corpus が誤りだと確定した**以上、
記述を残すと次に読む者が必ず拾う。

## 対象範囲

### (a) `README.md`（このディレクトリ）

| 箇所 | 現在 | 直す先 |
|---|---|---|
| フェーズ表 04 行 | 「実機確認済み…両リポジトリ未コミット」 | **完了**（`728ad06` / autodj は `1e34dab`） |
| フェーズ表 06 行 | 未着手 | 依存に「05a–05e 完了」と「798曲を聴き終えていること」 |
| 冒頭の図 | `classify_*.txt を再生成 → 旧 corpus と diff = 仮実装の誤りの所在` | **この枝を落とす。** ラベル → 突合先はキャッシュ済みスコアだけ |
| 「なぜやるか」 | 「精度評価が循環している」 | 循環に加えて、**corpus 自体が動作テストの産物で内容が誤っている**ことを書く |
| 「調査で確定した事実」 | 「旧 corpus 393件のパスは全て現存（diff 可能）」 | **削除。** 「旧 corpus は流用しない」に置き換える |
| 全計画に共通する注意 3 | `MIN_DURATION_SECS` 未満は手動ラベルが付いても掃引に使えない | 一般論としては正しいが、**このライブラリでは発生しない**旨を書く（件数は `./scripts/labeling-facts.sh`） |
| フェーズ表 | 05a–05e の行を追加 | 05 と 06 の間に置く |

### (b) `phase-06-export-and-tuning.md`

**削除する**

- 対象範囲 **(b)「旧 corpus との突合」の節全体**
- 受け入れ条件 **2**（「旧 corpus との diff が取れ、仮実装が外していた曲が列挙できる」）
- 検証コマンドの `diff <(sort testdata/classify_funkot.txt) …` の2行
- 報告形式 **4** の「旧 corpus との diff 要約」

**書き換える**

- 冒頭の依存行に 05a–05e を足す
- (a) エクスポート: パス変換の実体を明記 —
  `\\LAPTOP-QM7J9GBE\music\<rel>` ↔ `/mnt/oldpc/music/<rel>`。
  後者は WSL 再起動でマウントが外れるので着手時に `oldpc-music`
- (c) しきい値調整: 掃引の入力を **05b の `classify_baseline_798.tsv`** と明記
- (d) 精度の再測定: 「循環した数字なので、そのまま残さない」を
  **「誤ったデータから出ている数字なので、そのまま残さない」**へ。
  循環しているだけなら測り直せば救えるが、元データが誤っている場合は救えない
- 「注意」の `MIN_DURATION_SECS`: **このライブラリでは発生しない**旨を追記（件数は `./scripts/labeling-facts.sh`）。
  「何曲該当したかは記録する」は残す（ライブラリが変われば復活する）
- 「完了後」の「新しい `classify_*.txt` をコミットする。旧版は git log に残る」を
  **訂正**。`testdata`（`funkot-autodj-for-ui/.gitignore`）が `/testdata/*` を除外しており
  未追跡。除外理由は**ユーザーの実ライブラリのファイル一覧を public repo へ
  出さないため**。差し替え前に 05b のバックアップ先へ退避する運用に書き換える

### (c) `funkot-core/examples/classify_probe.rs` の doc コメント（1–12行付近）

しきい値の根拠として corpus 3ファイルを表で挙げている箇所。
**この corpus は正解データではない**旨と、人手ラベル基準へ差し替える予定である旨に直す。
コードは変更しない。

### (d) `HANDOFF.md`（funkot-player）

「現在地」「次にやること」「途中状態」を更新する。特に:

- 「いまラベルと履歴は空」→ ラベルは空、**履歴は 05c で初期化する**（現状は残骸あり）
- v14 キャッシュの全再解析は**済んでいる**（798件すべて `classify_scores` 完備）
- 次にやることを 05a–05e → 自己一致率 → 798曲 → 06 の順に書き直す

**local-data 配下なので commit しない**（`~/.claude/rules/git-commit-policy.md` の
「判断を仰ぐ理由」2）。

## 対象外

- `ISSUES.md` からの行削除（「Non-Funkot を再生中であることを示すアイコンが無い」）。
  phase-06 の「完了後」に属する
- `CHANGELOG` の精度表の書き換え。phase-06 (d) の成果物であり、
  **人手ラベルが揃うまで書き直せない**
- しきい値・判定ロジック・`CACHE_VERSION` の変更
- 旧 corpus ファイルの削除そのもの（05c）

## 関連ファイル

| パス | 役割 |
|---|---|
| `.claude/plan-phases/funkot-labeling/README.md` | 分割計画のインデックス |
| `.claude/plan-phases/funkot-labeling/phase-06-export-and-tuning.md` | 主な書き換え対象 |
| `funkot-autodj-for-ui/funkot-core/examples/classify_probe.rs` | doc コメント |
| `testdata`（`funkot-autodj-for-ui/.gitignore`） | `/testdata/*` の除外。訂正の根拠 |
| `funkot-player/HANDOFF.md` | local-data へのシンボリックリンク。commit しない |

## 制約・不変条件

- **数字は実測を書く。** 引き写さない。書いた数字はすべて検証コマンドで再現できること
- phase-06 の**構造（(a)(c)(d) の並び、受け入れ条件の番号体系）は保つ**。
  (b) を落とした結果の番号ズレは詰めてよいが、残る条件の文言は変えない
- `README.md` のフェーズ表の列構成を変えない
- コードは変更しない。`classify_probe.rs` は doc コメントのみ
- `HANDOFF.md` は commit しない。それ以外はコミットする（ドキュメントのみなので
  message に `[skip ci]` を付ける）

## 受け入れ条件

1. `phase-06-export-and-tuning.md` に `classify_funkot.txt` / `classify_not_funkot.txt` /
   `classify_funkot_hhhb.txt` への参照が**1つも残っていない**（「流用しない」と
   書く箇所を除く）
2. 同ファイルに `/mnt/oldpc/music` と `\\LAPTOP-QM7J9GBE\music` の対応が書かれている
3. `README.md` のフェーズ表に 05a–05e の5行があり、04 行が「完了」になっている
4. `classify_probe.rs` の doc コメントが corpus を正解データとして紹介していない
5. `cargo test -p funkot-core` が通る（doc コメント変更が doctest を壊していないこと）
6. `git -C funkot-player status --short` の差分がドキュメントのみ

## 検証コマンド

```bash
cd <workspace-root>

P=funkot-player/.claude/plan-phases/funkot-labeling
grep -c 'classify_funkot.txt\|classify_not_funkot.txt\|classify_funkot_hhhb.txt' $P/phase-06-export-and-tuning.md
grep -c 'oldpc/music' $P/phase-06-export-and-tuning.md
grep -c 'phase-05[a-e]-' $P/README.md          # 5 以上

cd funkot-autodj-for-ui
cargo test -p funkot-core

git -C ../funkot-player status --short
git status --short
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 落とした記述と、その理由をどう残したか。番号を詰めた箇所
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に受け入れ条件1の `0` と `cargo test`
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — `CHANGELOG` の誤った数字が phase-06 まで残ること、
   その間に誰かが引用する危険

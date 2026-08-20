# 03. 事実を1箇所から出す

**リポジトリ:** funkot-player / **依存:** なし（01・02 と並行してよい）

## 目的

機械が答えられる事実を、毎回その場の書き捨てスクリプトで再導出するのをやめる。

前回のセッションは 798 / 412 / 汚染1件 / 30秒未満0 / トップディレクトリ数 を
導くのに約8回の tool call を使い、うち2回はバックスラッシュのエスケープ失敗で
空振りした。**同じ問いに毎回違うコードで答えている限り、答えは毎回違いうる。**

**このスクリプトが funkot セッションの最初のコマンドになる。**

## 対象範囲

`funkot-player/scripts/labeling-facts.sh` を新規追加する。1コマンドで1画面。

### 印字する項目

**作業ツリー**

- ワークスペースルート（`funkot-player` と `funkot-autodj-for-ui` の両方を直下に持つ
  最初のディレクトリまで親を辿る。`funkot-workspace-root` の規則どおり。推測しない）
- 両リポジトリの branch / 短縮 sha / dirty 件数（`git -C` で。cwd 頼みにしない）
- `/mnt/oldpc/music` のマウント有無

**キャッシュ**

- 件数 / `version` の分布 / `is_funkot` が真の件数 /
  `intro_bars_manual`・`outro_bars_manual`・`outro_structure_bars_manual` が真の件数 /
  `needs_reanalysis` が真の件数 / `classify_scores` が欠損している件数 /
  30秒未満（`total_frames` ÷ `sample_rate`）の件数

**アプリ状態**

- `labels.json` の件数、`history.json` の有無と件数
- `settings.json` の `allow_non_funkot` / `labeling_mode` / `music_dir`
- `hash-index.json` の件数とトップディレクトリ数

**残骸検知**

- `funkot-autodj-for-ui/testdata/` の内容を許可リストと照合し、
  未知のファイルを警告する

  構造5（誤りと分かったデータが正解データの名前と場所のまま居座る）の再発検知。
  旧 corpus はまさにこの経路で「正解」として扱われ、プラン全面書き直しを招いた

### 照合

期待値はスクリプト冒頭の宣言に置く:

```sh
EXPECT_CACHE=798
EXPECT_IS_FUNKOT=412
EXPECT_MANUAL=0
EXPECT_NEEDS_REANALYSIS=0
EXPECT_UNDER_30S=0
EXPECT_TOPDIRS=103
```

差分が出たら**該当項目を明示して exit 非0**。ライブラリが変われば1箇所を直す。
「どれを直すか」を毎回考えずに済むように、宣言を1箇所へ集める。

`--print` で照合なしの素の出力。

## 対象外

- CI への追加。**ユーザーの実データと音楽共有が要るので CI では走らない。**
  CI に載るのは `check-doc-claims.sh`（01）だけ
- アプリ実データの変更。**読み取り専用**
- キャッシュの再生成や再解析（`funkot-labeling/phase-05c-test-residue-purge.md`）
- 文書側の書き換え（04）
- 自己一致率の計算（`funkot-labeling/phase-05d-agreement-harness.md`）

## 関連ファイル

| パス | 役割 |
|---|---|
| `scripts/check-release-invariants.sh` | 形の手本（POSIX sh、`status`、`exit`） |
| `scripts/win-run.sh` | ワークスペースルート相対でパスを組む書き方 |
| `%APPDATA%\jp.hatsuboshi.funkotplayer\` | 読み取り対象 |
| `src-tauri/src/store.rs` | 各 JSON のファイル名定数。読む対象の正本 |
| `funkot-core/src/cache.rs` | `ClassifyScores` のフィールド名 |

## 制約・不変条件

- **読み取り専用。** アプリ実データを1バイトも書き換えない
- アプリのデータディレクトリを決め打ちしない。既定を持ちつつ引数か環境変数で上書き可
- WSL からも Git Bash からも動くこと。**バックスラッシュを含む UNC パスの扱いを
  1箇所に閉じる**（前回2回空振りした箇所）
- 依存を足さない。POSIX sh + 既にあるもので済ませる。
  `jq` が無い環境で落ちない
- 798件の JSON を読むので、1ファイル1プロセス起動を避ける
- **数字を文書へ書き戻さない。** このスクリプトが唯一の出どころ

## 受け入れ条件

1. `scripts/labeling-facts.sh` が存在し、実行ビットが立っている
2. 引数なしで実行すると上記すべてを印字し、現状の実データに対し **exit 0**
3. `--print` が照合をせず出力だけ出す
4. 期待値を1つ書き換えると **exit 非0** になり、**どの項目が食い違ったかを名指しする**
5. アプリ実データの mtime が実行前後で変わらない
6. ワークスペースルートを自力で解決し、印字する
7. `testdata/` に未知のファイルを置くと警告が出る

## 検証コマンド

```bash
cd <workspace-root>/funkot-player

test -x scripts/labeling-facts.sh && echo EXECUTABLE
./scripts/labeling-facts.sh; echo "exit=$?"        # 0
./scripts/labeling-facts.sh --print | head -30

# 読み取り専用であること
APP=/mnt/c/Users/<user>/AppData/Roaming/jp.hatsuboshi.funkotplayer
find "$APP" -newermt '-2 minutes' | wc -l          # 0

# 腐りを検出できることの実証（省略しない）
sed -i 's/EXPECT_IS_FUNKOT=412/EXPECT_IS_FUNKOT=999/' scripts/labeling-facts.sh
./scripts/labeling-facts.sh; echo "exit=$?"        # 非0。IS_FUNKOT を名指しすること
git checkout scripts/labeling-facts.sh

# 残骸検知の実証
touch ../funkot-autodj-for-ui/testdata/bogus-ground-truth.txt
./scripts/labeling-facts.sh 2>&1 | grep -i bogus
rm ../funkot-autodj-for-ui/testdata/bogus-ground-truth.txt

git status --short
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — 各項目の算出方法、ワークスペースルートの解決方法、
   UNC パスの扱いを閉じた場所、798件を読む方法
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。
   **特に受け入れ条件4（期待値を壊すと落ちる）の実証。省略しない**
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）。
   `testdata/` 許可リストの中身を含む
6. **未解決事項と残存リスク** — 実行にかかった時間、
   アプリ起動中に走らせた場合の見え方

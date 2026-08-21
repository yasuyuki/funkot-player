# 05b. 削除前に基準値を凍結する

**リポジトリ:** funkot-autodj-for-ui（生成物の置き場）/ **依存:** なし
**後続の制約:** **05c より前に必ず終わらせる。** 05c はここで凍結した値を消す

## 目的

`funkot-cache` の798件を削除する前に、phase-06 が必要とする基準値を取り出して固定する。

**旧 corpus 393件は動作テストの過程で作られたもので内容が誤っており、流用しない。**
したがって phase-06 に残る比較基準は、ここで凍結する現行判定だけになる。取り損ねると
「しきい値を動かして何曲の見え方が変わったか」が測れなくなる。

現行キャッシュの実測（このフェーズで再確認する数字）:

| 項目 | 値 |
|---|---|
| キャッシュ総数 | 798（全件 `version: 14`、`classify_scores` 完備） |
| `is_funkot: true` | 412 |
| `*_manual: true` | 1（`73d3980….json` = `AniManyao Japan - ADM EXPO - 01 PP-Kamen (FKHouse Rmx).m4a`） |
| `needs_reanalysis: true` | 0 |
| 30秒未満（`total_frames / sample_rate < 30`） | **0** |
| トップディレクトリ数 | 103 |

## 対象範囲

### (a) 分類基準の凍結

`funkot-autodj-for-ui/testdata/classify_baseline_798.tsv` を生成する。1行1曲、
ヘッダ行あり、タブ区切り:

```
hash	rel_path	is_funkot	head_z	head_z_ratio	head_half_ratio	tail_z	tail_z_ratio	tail_half_ratio
```

- `hash` はキャッシュのファイル名（`<hash>.json`）
- `rel_path` は `hash-index.json` の絶対パスから
  `\\LAPTOP-QM7J9GBE\music\` を除いた相対部分（区切りは `/` へ正規化）
- 浮動小数は **キャッシュ JSON の値をそのまま文字列として写す**。丸めない。
  05c の一致比較が桁落ちで落ちる

### (b) パス対応表

`funkot-autodj-for-ui/testdata/path_map_798.tsv` を生成する:

```
hash	unc_path	wsl_path
```

`wsl_path` は `/mnt/oldpc/music/<rel_path>`。**生成後、798件すべてについて
`wsl_path` の実在を確認する。** `/mnt/oldpc/music` は WSL 再起動でマウントが外れるので、
着手時に `oldpc-music` を実行してから始める。

これは phase-06 (a) のエクスポートが要求するパス変換の実体でもある。

### (c) アプリ実データの複製

`%APPDATA%\jp.hatsuboshi.funkotplayer` 全体を
`%APPDATA%\jp.hatsuboshi.funkotplayer.bak-<YYYYMMDD-HHMMSS>` へ複製する。
既存の `jp.hatsuboshi.funkotplayer.bak-20260811-230513` と同じ命名にそろえる。

**05c がここへ旧 corpus も退避する。** 退避先のパスを報告に明記すること。

## 対象外

- キャッシュやアプリ実データの**削除**（05c）
- `.gitignore` の変更。`testdata/` が除外されているのは**ユーザーの実ライブラリの
  ファイル一覧を public repo へ出さないため**であり、解除は別の判断
- 生成物のコミット。`testdata/` は gitignored のまま。**コミットしない**
- 旧 corpus の内容を使った突合や検証。誤りと確定している

## 関連ファイル

| パス | 役割 |
|---|---|
| `%APPDATA%\jp.hatsuboshi.funkotplayer\funkot-cache\*.json` | 798件。`classify_scores` の出どころ |
| `%APPDATA%\jp.hatsuboshi.funkotplayer\hash-index.json` | 絶対パス → `{hash, title, artist}` |
| `funkot-autodj-for-ui/testdata/` | 生成物の置き場（gitignored） |
| `funkot-core/src/cache.rs` | `ClassifyScores` の定義。フィールド名の正本 |
| `funkot-core/examples/classify_probe.rs` | `--cache-dir` でスコアを読む側。TSV の列を合わせる先 |

## 制約・不変条件

- **読み取り専用。** このフェーズでアプリ実データを1バイトも書き換えない（複製は作る）
- アプリが起動中でも実施してよいが、**再生・ラベル操作をしていない状態**で行う
- 浮動小数は文字列として写す。パースし直して再出力しない
- `hash-index.json` は 798 エントリある。キャッシュ側と**件数・ハッシュ集合が一致する
  こと**を確認する。片方にしか無いものがあればそれ自体を報告する

## 受け入れ条件

1. `classify_baseline_798.tsv` がヘッダ1行 + **798行**
2. 同ファイルの `is_funkot` 列で `true` が **412**
3. `path_map_798.tsv` が798行で、`wsl_path` 列の**全件が実在**する
4. キャッシュのハッシュ集合と `hash-index.json` のハッシュ集合が完全一致
5. バックアップ先に `funkot-cache` が **798件**あり、`settings.json` / `labels.json` /
   `history.json` も複製されている
6. `git -C funkot-autodj-for-ui status --short` に差分が出ない（生成物は gitignored）

## 検証コマンド

```bash
# WSL。着手時にマウントを確認
oldpc-music
ls /mnt/oldpc/music | head -3

# cache / settings / labels（数字の正本）
cd <workspace-root>/funkot-player
./scripts/labeling-facts.sh

cd <workspace-root>/funkot-autodj-for-ui

wc -l testdata/classify_baseline_798.tsv        # 799（ヘッダ込み）
awk -F'\t' 'NR>1 && $3=="true"' testdata/classify_baseline_798.tsv | wc -l    # 412
wc -l testdata/path_map_798.tsv                 # 799

# wsl_path の実在確認（出力が 0 であること）
awk -F'\t' 'NR>1{print $3}' testdata/path_map_798.tsv | while IFS= read -r p; do
  [ -f "$p" ] || echo "MISSING: $p"
done | wc -l

BAK=$(ls -dt /mnt/c/Users/*/AppData/Roaming/jp.hatsuboshi.funkotplayer.bak-* | head -1)
echo "$BAK"
ls "$BAK/funkot-cache" | wc -l                  # 798

git status --short                              # 空
```

## 報告形式

1. **変更したファイル** — パスと、各ファイルで何をしたか1行ずつ
2. **実装内容** — TSV の列定義、パス正規化の方法、バックアップ先の絶対パス
3. **実行したコマンド** — 上記検証コマンドの実コマンド
4. **テストおよび検証結果** — 出力を貼る。特に 798 / 412 / 実在確認 0 / バックアップ 798
5. **仮定した事項** — 仕様に無く自分で決めた箇所（無ければ「なし」）
6. **未解決事項と残存リスク** — キャッシュと `hash-index.json` の集合差、
   マウントが外れた場合の影響

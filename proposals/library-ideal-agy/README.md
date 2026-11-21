# Funkot Player 理想音楽ライブラリUI提案（Antigravity 独立案）

- 実行契約: [yasuyuki/funkot-player#169](https://github.com/yasuyuki/funkot-player/issues/169)
- 提案ブランチ: `proposal/library-ideal-agy`
- インタラクティブ試作: [prototype/index.html](prototype/index.html)
- 自動検証・撮影スクリプト: [verify-and-capture.mjs](verify-and-capture.mjs)
- 検証結果データ: [verification-report.json](verification-report.json)

---

## 1. デザインコンセプト：「Jakarta Midnight Studio — Crate & Destination Dock」

### 目指す感情と音楽体験
深夜のスタジオやレコードクレートから、「今この流れに合う1曲」を迷わず掘り当て（Dig）、曲名を吟味し、狙った送り先へ一撃で送り込むための専用空間を設計しました。業務アプリ然とした3列テーブルや管理画面ボタン群から脱却し、**「探す・聴く（Phosphor Amber）」** と **「追加先へ送る（Signal Jade-Cyan）」** の2つの目的を、静かな深藍（Obsidian Indigo）の画面上で明確な色の対話として分離しています。

架空のジャケット画像・波形・クロスフェーダー等の実装不可能な装飾は一切置かず、Funkot Playerが実際に扱うデータ（曲名、アーティスト、ファイルパス／`content_hash` 識別、制作年・ジャンル・任意タグと由来、Funkot判定ラベル、イントロ／アウトロ小節数、再生元と追加先の分離）を、タイポグラフィの強弱と音響機材的なLED／コンソールキーの質感だけで成立させています。

### 現行UIおよび過去案と根本的に異なる3つの構造刷新

1. **非対称2領域スタジオ構成（3列固定の廃止）**
   - **Desktop (`1280×900`)**: 画面左73%（`minmax(0, 1fr)`）を「曲の発見と曲名読み取りのための主舞台」として開放し、右332pxを「いま1クリックで曲を送り込む先」を固定表示する **Destination Lock Dock** としています。
   - **Narrow/Touch (`412×915`)**: ライブラリ舞台を全幅100%に広げ、親指の届くボトム再生バー直上に **Thumb Destination Strip**（タップでシート展開して切替・内容確認可能）を固定配置しています。
2. **数千タグ対応「5分類ファセットスタジオ ＋ 有界条件ストリップ」**
   - 巨大な `<select>` や無制限折り返しチップを廃止し、検索バー直下に開閉する **Faceted Crate Studio** を導入しました。
   - 3,420個のタグ候補を **制作年 / 制作圏・作家 / 原曲・文化 / 曲調・構成 / 状態・管理** の5分類へ整理し、インクリメンタル文字絞込・表記揺れ案内（例: `Anime Remix` → `アニソンremix`）・追加後のヒット予測件数（`1,490 / +で6曲`）をリアルタイム提示します。
   - 適用中の条件ピルが3件を超える場合（8〜9条件や長大タグ名を含む場合）は、条件ストリップを3件＋`+他 N 条件` ドロワーボタンに抑え、ツールバーが多段化して曲一覧を押し潰す破綻を構造的に防ぎます。
3. **操作領域の大きさと視覚的強度の分離**
   - 各曲行の視線の主役は **曲名（`17.28px`, `#F3F5F9`, weight `650`）** です。
   - 右端の追加ボタン `+` / `✓` は **44×44px** の物理ヒット領域を確保しつつ、通常時の見た目を低彩度の薄い枠線と細身のJade-Cyan記号（`rgba(20, 184, 166, 0.043)`）に抑え、曲名より視覚的に目立たない主従関係を徹底しています。

---

## 2. デザイン言語とトークン体系

| トークン役割 | カラー値 | 用途と制約 |
|---|---|---|
| **Studio Obsidian Indigo** | `#0C0F17` | 画面基調背景。純黒の無機質さを避けたスタジオ基調色 |
| **Console Slate** | `#141923` / `#1B2230` / `#232C3E` | 検索レンズ、ファセットスタジオ、追加先ドックの階層面 |
| **Chalk Alabaster** | `#F3F5F9` | **曲名（主役）**およびアクティブ入力専用の最高輝度インク |
| **Pewter Silver** | `#94A3B8` / `#6E7F98` | アーティスト名、年・BPM・時間、非選択タグ、ファイルパス補足 |
| **Phosphor Amber** | `#F59E0B` / `#FBBF24` | 検索レンズ、有効検索条件ピル、現在再生中の行LED・ラベル専用 |
| **Signal Jade-Cyan** | `#14B8A6` / `#2DD4BF` | 追加先ターゲット枠、1操作追加ボタン、`✓ 追加済`、Undo通知専用 |
| **Diagnostic Crimson** | `#FB7185` | 保存競合エラー、非Funkot判定ゲート、下書き内の除外対象表示 |

書体は日本語・英字の曲名視認性を優先したサンセリフ（`Plus Jakarta Sans` / `Segoe UI Variable Display` / `Hiragino Kaku Gothic ProN` / `Yu Gothic UI`）と、件数・BPM・ハッシュ桁揃え用の等幅（`JetBrains Mono` / `Cascadia Mono`, `tabular-nums`）の2系統に限定しています。

---

## 3. 高品質な実画面キャプチャ（Desktop `1280×900` / Narrow `412×915`）

| 状態 | Desktop `1280×900` | Narrow/Touch `412×915` | 確認できる設計ポイント |
|---|---|---|---|
| **01. 通常ライブラリ** | [01-default-desktop](captures/01-default-desktop-1280x900.png) | [01-default-narrow](captures/01-default-narrow-412x915.png) | 曲名主役・控えめな44×44追加キー整列・再生元と追加先の明確な分離 |
| **02. 複合検索編集中** | [02-facet-studio-desktop](captures/02-facet-studio-desktop-1280x900.png) | [02-facet-studio-narrow](captures/02-facet-studio-narrow-412x915.png) | 3,420タグ候補の高速絞込、5分類ナビ、AND絞込予測件数の提示 |
| **03. 3タグAND検索結果** | [03-compound-results-desktop](captures/03-compound-results-desktop-1280x900.png) | [03-compound-results-narrow](captures/03-compound-results-narrow-412x915.png) | `2015年 AND 日本人トラックメーカー AND アニソンremix` 一致6曲と同名別ファイル・同一音源識別 |
| **04. 1操作追加＋曲詳細展開** | [04-add-and-inspect-desktop](captures/04-add-and-inspect-desktop-1280x900.png) | [04-add-and-inspect-narrow](captures/04-add-and-inspect-narrow-412x915.png) | 1クリック追加後の右ドック反映、Undo通知、12タグ展開・曲補正入口 |
| **05. 9条件＋長大タグ負荷** | [05-scale-9conditions-desktop](captures/05-scale-9conditions-desktop-1280x900.png) | [05-scale-9conditions-narrow](captures/05-scale-9conditions-narrow-412x915.png) | 9条件・長文タグ時も条件バーを1帯域に収め、曲一覧開始Y位置を維持 |
| **06. 0件診断＋保存競合エラー** | [06-exceptions-zero-error-desktop](captures/06-exceptions-zero-error-desktop-1280x900.png) | [06-exceptions-zero-error-narrow](captures/06-exceptions-zero-error-narrow-412x915.png) | 年条件の矛盾理由提示と1クリック回復、下書きを保持したままの再読込導線 |
| **07. 200%文字拡大** | [07-zoom-200pct-desktop](captures/07-zoom-200pct-desktop-1280x900.png) | [07-zoom-200pct-narrow](captures/07-zoom-200pct-narrow-412x915.png) | 横溢れ0px・単一列リフローにより拡大時も曲名と操作を欠損させない |

---

## 4. 操作できるデザイン試作の使い方

ローカルで外部通信やビルド環境なしにそのまま動作します（合成音楽データのみ使用）。

1. [prototype/index.html](prototype/index.html) を Chromium / Edge / Firefox 等で開く（または静的HTTPサーバー経由で表示）。
2. **必須シナリオ(A) 複合検索の構築**:
   - `タグ・条件 (3,420)` を押し、検索欄または5分類から「2015年」「日本人トラックメーカー」「アニソンremix」を選ぶ。`Anime Remix` と入力しても表記揺れ候補として `アニソンremix` を提示。
3. **必須シナリオ(B) 条件編集・解除・復帰**:
   - 条件ピルの `×` で1条件外すと結果が `6曲 → 7曲` へ広がり、すぐ隣に現れる `条件を元に戻す` で即復帰。`AND一致` / `OR一致` の切替も1クリック。
4. **必須シナリオ(C) 曲識別と1操作追加**:
   - 右端の控えめな `+`（44×44px）を1回押すと選択中の「追加先ターゲット」末尾へ追加され、`✓` 状態・ドック反映・`元に戻す` トーストが出る。行の `+8タグ` で12タグ全展開、`⋯` でタグ編集・曲補正モーダル（保存競合シミュレーション付き）を開ける。
5. **必須シナリオ(D) 狭幅および検証プリセット**:
   - 画面上部の `検証ケース` セレクタ（narrow時は右上 `設定` 内）、またはURLパラメータ `?preset=default | facet-open | and-3tags | add-inspect | scale-9tags | zero-conflict | zoom-200` で全状態へ直接移動できる。

---

## 5. 規模と例外の設計

- **数万曲・数千タグ候補**: 代表サンプル19曲に対してライブラリ総数 `24,840曲・3,420タグ` 規模を前提とし、タグ検索は5分類ファセット＋インクリメンタル候補フィルタ＋別名照合でスクロール地獄を排除。
- **8条件以上・長大タグ名**: 条件ストリップを最大3ピルに制限し、超過分は `+他 6 条件 (9件中)` の条件ドロワーへ格納。Desktopでは曲一覧開始位置 `ledgerTopPx = 209px`、Narrowでも `361px` を維持し、条件が9個に増えても曲一覧が押し出されない。
- **長い曲名・12タグ曲・重複／同名別ファイル・メタデータ欠落**:
  - 長い曲名は2行折り返しで判別語尾まで読め、詳細展開時は全文表示。
  - 同名別アレンジ（例: `Guren no Kaze` 182 BPM / 180 BPM）はパス差とBPM差を識別バッジで明示。
  - 同一 `content_hash` の複数ファイルは `同一音源 2ファイル共有` として表示。
  - メタデータ欠落ファイルはファイル名を表示しつつ「アーティスト未設定」「年未設定」を明確化。
  - 非Funkot判定曲は追加ボタンをロック記号 `⊘` とし、`⋯` 内の `手動でFunkotとして許可`（`BarOverride::funkot`）へ案内。
- **0件・処理中・失敗・200%文字拡大**:
  - 0件時は「なぜ0件になったか」（例：`2015年` と `2018年` のAND競合）を言語化し、`OR一致へ切替` / `直前の条件を外す` を提示。
  - 処理中表示と `stale_revision` 保存競合エラーは入力中の下書きを破棄せず、`下書きを確認・再読込` で復帰可能。
  - `200%` 文字拡大時はDesktopでも1列＋ボトム追加先バーへ自動リフローし、横スクロール溢れ `0px` を維持。

---

## 6. 評価の根拠（動作検証と視覚審査）

Playwright (Chromium) による自動操作・幾何測定（[verify-and-capture.mjs](verify-and-capture.mjs)）および全14枚のスクリーンショット目視確認を実施した結果：

- **操作手順と実測**:
  - Desktop (A)(B)(C): 初期 `19 曲` → 3条件AND追加で `6 曲` → 1条件解除で `7 曲` → `条件を元に戻す` で `6 曲` 復帰 → `+` 1クリックで `3 曲登録済 → 4 曲登録済`、`元に戻す` で `3 曲登録済` に復帰。操作中、`再生元: 再生待ち` は一切切り替わらないことを検証。
  - Narrow (D): `412×915` で同検索（`6 曲`）→ 1タップ追加（`アニソンFunkot 2015特選 (4曲)`）→ 下部バーからシートを開き `再生待ち (4曲)` へ切替成功。
- **視覚階層・物理サイズ・狭幅耐性の実測値**（[verification-report.json](verification-report.json)）:
  - **横溢れ**: Desktop / Narrow / 9条件ドロワー展開 / 200%文字拡大の **全15チェックで `horizontalOverflowPx = 0`**。
  - **曲名 vs ボタンの主従**: 曲名 `17.28px` (`#F3F5F9`) に対し、追加ボタンは物理サイズ `44×44px` 以上を確保しつつ背景 `rgba(20, 184, 166, 0.043)` の控えめな輪郭に抑制。
  - **初回視線誘導と読み取り幅**: 通常Desktopで `167px` から曲一覧が開始し、3〜9条件時は `209px` で一定。初期調査で見つかった狭幅時のGrid列ズレ（右端ボタンの切れ）および狭幅200%拡大時の横溢れ `124px` はCSS構造修正により解消し、再撮影して目視確認済み。

---

## 7. 現行データ契約との照合・後続実装検討事項

### 現行契約（`CONTEXT.md` / `docs/track-tags.md` / `docs/strategy.md`）との整合
- `list_track_tags` / `update_track_tags` のパッチモデル（`year_change: auto | set | unset`, `add` / `remove`, `origin: embedded | manual | both`, `stale_revision` 時の下書き保持）と完全整合。
- `BarOverride::funkot` / `effective_is_funkot` の手動許可UI、および「再生元と追加先の分離」「同一曲のプレイリスト複数登録」の語彙・仕様を反映。

### 後続実装検討事項（採用決定後に別Issueで計画）
1. **3,420規模タグのフロントエンド索引と5分類マッピング**: `Tag` データモデルに保存先を変えないクライアント側のカテゴリ分類ルール（あるいは任意の表示用分類マップ）と表記揺れ辞書をどう持たせるか。
2. **ファセット候補ごとの「追加した場合の一致件数（+でN曲）」の高速計算**: 2万〜5万曲規模でのBitset/転置インデックス導入によるリアルタイム集計の最適化。
3. **「プレイリストではなくブリーフ（母集合・尺・展開）」への拡張**: `Destination Lock Dock` の「追加先」選択肢に、将来 `DrainPolicy` を拡張した意図ベース選曲ブリーフの母集合指定を統合するUI接続。

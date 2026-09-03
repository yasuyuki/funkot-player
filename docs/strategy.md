# funkot-player の戦略

この文書は**何を作るかではなく、何に賭けているか**を書く。機能の是非で迷ったら
ここに照らす。手順は README、次の一手は HANDOFF.md、設計判断の理由はコード
コメントにあり、ここには置かない。

---

## 1. 賭け

**エンジンが製品。プレイヤーはその前面のひとつ。**

> **Funkot というジャンルに限れば、全自動が人間の rekordbox 運用に勝つ。**
> rekordbox は、他ジャンルと混ぜる人・自動化不能な高度なプレイをする人向けの応用。

「最終像」ではなく**一文の賭け**を北極星に置く。理由は、賭けは反証できるが最終像は
できないからである。「実使用から学ぶ」と決めた企てにとって、最終像とは*最も情報が
少ない時点で打つ約束*でしかない。外れたらこの一文を書き換える。

価値の本体は `funkot-core` の区間解析とつなぎ判断にある。プレイヤー、CLI、
rekordbox 書き出しはいずれもその出力口であり、それ自体が資産ではない。

---

## 2. 境界

賭けから機械的に導かれる線引き。

- **DJ モードは PC 専用。** 実プレイの音声保存も rekordbox 書き出しも PC 専用。
  Android 版は BGM プレイヤーと手直し回収に徹する
- **差別化に寄与しない汎用機能は「あっても勝てないもの」として扱う** —
  曲順を人間が指定するプレイリスト、録音そのもの、rekordbox 互換
- **曲順を人間が指定する機能は賭けの反対側にある。** 作るなら順序ではなく
  *意図*を受け取る形にする（→ §4 の項目3）

### 「実処理は funkot-cli、UI は player」の実装形

意図は正しいが、実装としては **`funkot-core` に降ろして cli と player の両方から
呼ぶ**。player は `funkot-core` への path 依存しか持たず、`funkot-cli` は別クレートの
実行ファイルである。MSIX で固めたアプリから兄弟リポジトリのバイナリを subprocess で
叩く形は配布が成立しない。

移す対象は小さい: `funkot-cli/src/wav_write.rs`（`WavStreamWriter` / TPDF dither /
`PeakStats`。`hound` は既に `funkot-core` の依存）と、cpal コールバック内から
`try_lock` で書くパターン。

---

## 3. 律速は回収レートである

エンジンが製品なら、**教師データの流入量がそのまま製品の成長速度**になる。

現在の回収経路は「⋮ → 意見を送る → ZIP → LINE 等」の一本きりで、**完全に一方通行**。
何件溜まっているかの表示すら無く、送り返す動機も無い。

外部ユーザーからの手直しは**まだ1件も届いていない**。この事実がロードマップの
前提であり、Phase 4 が存在する理由でもある。

---

## 4. 機能案の評価

| # | 項目 | 判定 |
|---|---|---|
| 1 | メイン画面 UI | **最優先。ただし診断を差し替える**（§6） |
| 2 | つなぎ修正画面 | 実使用待ちで正しい。**ただし funkot 手動 override は待たない**（下記） |
| 3 | プレイリスト | **順序指定として作ると反戦略。** 意図の指定に読み替えれば中核（下記） |
| 4 | エクスポート/インポート | 分離は正しい。**import は回収ループを双方向にする装置**で、backup より重い |
| 5 | DJ モード | PC 専用で確定。**配管は今、操作設計は実使用待ち** |
| 6 | 録音 | 最も安い（動く前例あり）。DJ モード配管の副産物 |
| 7 | rekordbox 書き出し | 降格。**技術的にも一番弱い**（下記） |
| 8 | トランジション強化 | 最も簡単なものから。残りは実使用待ち |
| 9 | 前半終了での移行 | 保留。来たら `funkot-autodj` の Stage 3 へ回す |

### 項目2の例外 — funkot 判定の手動 override

`Settings.allow_non_funkot` は既定 `false` で、解析が非 Funkot と判定した曲は
**enqueue もフォルダ drain も拒否される**（`allow_non_funkot`（`src-tauri/src/store.rs`））。判定を誤ると曲が
丸ごと消える、あるいは混ざるはずのない曲が混ざる。小節数の誤りは1回のつなぎが
悪くなるだけだが、こちらは母集合そのものが壊れる。

逃げ道は用意されていない。`BarOverride.funkot` と `effective_is_funkot` は
実装済みだが **"Not written by the current UI (data model only)"**
（`BarOverride::funkot` / `effective_is_funkot`（`src-tauri/src/store.rs`））。ゲートが実際に効くようになった分、override UI の不在は
以前より重い。実使用を待つ理由が無い唯一の UI 項目。

### 項目3の読み替え — プレイリストではなく「ブリーフ」

「全自動が人間の運用に勝つ」なら、人間に曲順を組ませる機能は賭けの反対側にある。
一方これは中核になる:

- **母集合**の指定（「この30曲から」）
- **尺**の指定（「90分」）
- **展開**の指定（「後半に向けて上げる」）

**順序ではなく意図を渡し、順序は機械が決める。** 実際の DJ が頭の中でやっていて、
どのツールも自動化していないのはここである。

既存のキュー（`次に再生`）は既に「次はこれ」を担っている。足りないのはこちら側。
受け皿もある: `DrainPolicy`（`src-tauri/src/queue.rs`）は現在 `ContinueFolder` の1ヴァリアント
のみで、明らかに拡張前提で書かれている。

### 項目7の技術的な弱さ

`TrackAnalysis` に**ビートグリッドは無い**。あるのは `first_downbeat` 1点と
`intro_bpm` / `outro_bpm` のみ。**キーは解析すらしていない。**

180 に time-stretch 済みの Funkot なら格子は算術的に再構成できるが、テンポが揺れる
素材では再構成できない。rekordbox は POSITION_MARK と TEMPO を持つ XML を import
できるので経路自体は存在するが、**曲によって品質が変わることを前提に**最小版を
出すのが正しい。

戦略的な使い道は残る。本職の DJ が cue を import して**動かさずに使い続けたか**は、
エンジンの判断に対する最も強い外部評価になる。ただし補正が自動で返る経路は無い
（DJ 側がコレクションを export し直す必要がある）。

---

## 5. 規律

項目8を検討した際に出た方針を、**9項目すべてに適用する**:

> 最も簡単にできるものだけ実装したところから始めて、実際の使用で問題が発生した時に、
> 問題を説明して機能強化を具体的に検討する

これは 8-04 の方針転換（「精度を自分の耳で詰めるのをやめ、他人の実使用を入力にする」）
と同じ規律である。機能案のリストもまた、新しい入力が1件も届かないうちに**同じ一つの
耳が書いた**ものであり、放っておくと精度の代わりに機能を詰める同じモードに戻る。

**Phase 4 に入る条件を数で先に決める。** 外部ユーザーからの手直しが N 件届く、
または具体的な不満が M 件言語化されるまで着手しない。N / M は未決（→ §7）。

---

## 6. 現状の事実（実測）

判断の根拠。数字は Pixel 8 Pro（412×916 CSS px）換算。

### 再生画面のクロムは約 290px、予約された min-height がその過半である

| 帯 | 高さ |
|---|---|
| body padding-top（`env(safe-area-inset-top)` fallback 3rem） | 64px |
| ヘッダ（再生/編集 segmented + ⋮） | 54px |
| NowCard（うち予約 min-height 43px） | 106px |
| Transport 行（**ボタン** ▶/⏸・⏭・⚑） | 46px |
| TransitionStrip（1行。予約 min-height 23px） | 23px |

**ボタンは 46px の1行、予約された min-height が 66px。** 予約は 500ms ポーリングで値が
遅れて届いてもレイアウトが跳ねないためにある（`nowTitle` / `nowArtist`（`src/components/NowCard.svelte`）、
`fromTitle` / `toTitle`（`src/components/TransitionStrip.svelte`）の予約領域）。**残る削減余地は
NowCard の予約 43px であり、ボタンではない。**

ライブラリ1行目は画面上端から約 492px に出る見込みである。**この行だけは実測ではなく、
1行化した TransitionStrip の高さ（`--font-size-md` × 1.5）と削れた flag-row から引いた算出値で、
Pixel 8 Pro 実機での再測が要る。** 上の表の残りは改修前の実測（412×916 CSS px 換算）に、
変更した帯だけを同じ方法で置き換えたものである。

### base button 規則が全コンポーネントに波及している

`src/tokens.css:105-116`:

```css
button { font-size: var(--font-size-lg);   /* 1.2rem */
         padding: var(--space-lg) 1.6rem;  /* .8rem 1.6rem */
         width: 100%; ... }
```

素の button が 54.4px 高・全幅になる。これを打ち消す `width: auto` が
**22 箇所・15 ファイル**に散っている（`git grep -c "width: auto" -- src` で再取得できる。
19 箇所と書いていたのは古い）。単発では base 規則の修正が最大の効果。

### 再生クロムは play モードだけが描く（改修済み）

`src/App.svelte` は NowCard / Transport / TransitionStrip を
`{#if ui.mode === "play"}` の内側に置く。編集モードで残るのは AuditionBanner
（試聴は FlaggedDetail から始まるので両モードで描く）と MiniBar だけで、**つなぎ修正画面は
ヘッダの直下から始まる。**

モード切替は `.header` の再生/編集 segmented control（`src/App.svelte`）である。編集モードでは
Transport ごと消えるので、切替をそこへ置くことはできない。**両モードの一段目はこの segmented
control、二段目はそれぞれの subtabs、FlaggedDetail からの戻りは `backToList` で、
どの画面からも上位へ返る道がある。**

### 項目8/9 はエンジン案件

`NavAction` は5種が実装済み（`RestartCurrent` / `TransitionToPrev` /
`JumpToPrevIntro` / `TransitionToNext` / `JumpToNextIntro`）だが、プレイヤーが
使うのは `NavAction::TransitionToNext`（`src-tauri/src/lib.rs`）**1種だけ**。残り4種は配線するだけ。

「前半終了の検出」は `funkot-core/src/structure.rs` の Foote checkerboard novelty
（`:97`）/ ループ性 / 前置モデルからのマハラノビス距離（`:137`）を、イントロ・
アウトロ窓ではなく**全曲に回す**話。実質 Stage 3 区間解析の拡張であり、
`funkot-autodj` 側の案件。

### 永続データの構成

`data_dir` の JSON 一式（`QUEUE_FILE` / `SETTINGS_FILE`（`src-tauri/src/store.rs`）とその並び）。**性質が2種類混ざっている**:

`*_FILE` 定数は12本ある（この節が「8本」と書いていた時期がある。再取得は
`grep -c '^const .*_FILE' src-tauri/src/store.rs`）。

| 分類 | ファイル | 失うと |
|---|---|---|
| **ユーザー所有**（捨てられない） | `queue.json` `library.json` `flags.json` `labels.json` `dismissed.json` `session.json` `settings.json` `window.json` | 手直しが消える |
| **ユーザー所有だが手直しではない** | `history.json` `play-log.jsonl` | 何をいつ聴いたかが消える。作り直せないが、手直しは1つも失われない |
| **導出**（捨ててよい） | `hash-index.json` `meta.json`、および `cache_dir/*.json` | 再構築される |

**版数フィールドはユーザー所有側に一つも無い。** 前方互換の手当ては
`#[serde(default)]` と「壊れていたら空で起動」だけ。エンジン側は
`CACHE_VERSION`（`funkot-core/src/cache.rs`）を持つが、方針は
「移行せず破棄・再解析」であり、ユーザー所有データには使えない。

`play-log.jsonl` だけは1行1件の JSON Lines で、他と違って追記しかしない。
壊れた1行は1回の再生を失うだけで済み、全損しない。**版数フィールドはここにも
入れていない** — record 単位の `#[serde(default)]` で足り、それで吸えない形の変更は
新しいファイル名で移行する方が安い。§7-1 の問いは既に利用者の端末にある上段の
ファイルの話であり、この新規1ファイルは答えを出さない。

### 識別子は二層になっている（衝突ではない）

- `library.json` は **content hash キー**（`Overrides`（`src-tauri/src/store.rs`））。
  ハッシュは `(長さ ‖ 先頭64KiB ‖ 末尾64KiB)` の SHA-256（`content_hash`（`funkot-core/src/cache.rs`））で、
  **リネーム・移動に耐える** — 可搬なプレイリストの資産
- ライブラリ／UI 側のトラック同一性は**フルパス**
- `hash-index.json` が **path → hash** を橋渡しする。mtime + len の指紋で
  再ハッシュを省く（`resolve_content_hash`（`src-tauri/src/store.rs`））

つまり手直しはハッシュに、表示はパスに紐づいており、両者は共存している。
**足りないのは逆引き（hash → path）だけ**で、材料は既にある。

### リリース済み `main` と作業線が 15 コミット離れている

- `main` = `origin/main` = `2c9172e`（Store 認証待ちのもの）
- 作業線 `recursive-music-scan` は **15 コミット先行**（再帰スキャン、フルパス
  キー化、hash-index とタグキャッシュ、`settings.json` とデスクトップの Music
  フォルダ変更、非 Funkot ゲート、Android share-sheet からの音源取り込み、
  起動レイテンシ修正）
- `is_funkot` / `CACHE_VERSION 13` への追随は**作業線では完了済み**。
  `main` にはそもそも `is_funkot` が無い

---

## 7. 実装前に決めるべき問い（未決）

**いずれも先に決めないと後から高くつく。この文書では決めていない。**

1. **ユーザー所有データに版数をいつ・どう入れるか。**
   項目4はこの形式を世に出す。利用者の端末にデータが溜まった後で入れると移行が要る。
2. **リリース済み `main` と 15 コミット先行の作業線をどう合流させるか。**
   Store 認証の結果が出る前か後か。
3. **hash → path の逆引きをどこに置くか。** 可搬なプレイリストと別環境への移行は
   これに乗る。`hash-index.json` を逆引きしてよいか、別に持つか。
4. **Phase 4 の着手条件 N / M（§5）をいくつにするか。**

---

## 8. ロードマップ

順序は「回収レートを上げる → ループを双方向にする → 配管 → 実使用が来てから」。

### Phase 0 — 判断（§7 の4問。実装ほぼ無し）

### Phase 1 — 回収レートを上げる（Android / 共通 UI）
- `tokens.css` の base button 規則を直し、散った `width: auto` を消す（§6 に件数）
- NowCard / TransitionStrip の予約 min-height を、跳ねない別手段
  （固定スロットかスケルトン）に置き換える
- ~~編集モードで再生クロムを描かない。ナビゲーションを新設する~~（済。§6）
- funkot 判定の手動 override UI（`BarOverride.funkot` を UI から書けるようにする）
- 回収の計器 — 手直しが何件溜まっているか、いつ送ったか

### Phase 2 — 回収ループを双方向にする
- ユーザー所有データの export / import（版数付き。backup と別環境への移行）
- **補正のマージ** — こちら側の補正が利用者へも流れる。エンジンが目に見えて
  良くなることが、送り続ける唯一の理由になる
- ブリーフ（母集合・尺・展開）の形式 — 項目3の読み替え版

### Phase 3 — DJ モードの配管（PC 専用）
- desktop 限定モードの土台（プラットフォーム条件付き機能の方針）
- 録音 — `wav_write.rs` を `funkot-core` へ降ろし、cli と player の両方から使う。
  実時間より速いオフライン書き出しは `Engine::set_realtime(false)` +
  `fast_forward_audition` が既存の型
- `NavAction` 残り4種の露出（純粋な配線）

### Phase 4 — 実使用が来てから決める（§5 の条件を満たすまで着手しない）
- DJ モードの操作設計（ブリーフ型の選曲を含む）
- トランジションボタンの量子化（小節／フレーズ丸め）
- 曲中の構造境界 → `funkot-autodj` の Stage 3 へ
- rekordbox 書き出し（最小版、品質のばらつき前提）

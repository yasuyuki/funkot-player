# Microsoft Store 提出手順（人が行う作業）

Windows の本配布は **MSIX + Partner Center**。署名は提出後に Microsoft が行う。
**Store に上げる MSIX は未署名**（自己署名はローカル試験専用。`packaging/msix/README.md` 参照）。

技術的なパック手順は [packaging/msix/README.md](../packaging/msix/README.md)。
プライバシー本文の正本は [privacy.md](privacy.md) / [privacy.html](privacy.html)。

---

## 全体の流れ

```text
1. Partner Center 登録
2. アプリ名予約（MSIX）
3. Identity を manifest に反映 → コミット
4. プライバシーポリシーを一般公開 URL にする
5. 未署名 MSIX を取得（CI 推奨）
6. Partner Center に提出セットを埋めてアップロード
7. 認証通過後、Store 実機で Music 配置〜再生を確認
```

順序の注意:

- **3 の前に 2**（Publisher / Name が無いと提出で弾かれる）
- **Identity 差し替え後は必ず MSIX を作り直す**（仮 Identity の artifact は提出に使わない）
- **4 の URL** は提出フォーム必須。private リポジトリのまま Pages が届かない場合は代替 URL を用意する

---

## 進捗チェックリスト

### リポジトリ側（済み）

- [x] `⋮ → Musicフォルダを開く`（配置 UX）
- [x] `docs/privacy.md` / `privacy.html`
- [x] `packaging/msix/`（manifest + `pack-msix.ps1`）
- [x] CI `windows-msix`（artifact `funkot-player-windows-msix`）

### 人が行う（未完）

- [x] A. Partner Center 個人開発者登録
- [x] B. アプリ名予約（**MSIX アプリ**）
- [x] C. `Package.appxmanifest` の Identity 差し替え（反映済み）
  - Name=`hatsuboshi.jp.Funkotplayer`
  - Publisher=`CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`
  - PublisherDisplayName=`hatsuboshi.jp`
- [x] D. プライバシーポリシーの一般公開 URL
  - **提出用（公開）:** https://yasuyuki.github.io/funkot-player/privacy.html
  - 予備（gist）: https://gist.github.com/yasuyuki/2bcd2f2737dd02e1622b2e593c258ade
  - リポジトリは **public**（Pages 用に公開済み）
- [x] E. Identity 反映後の未署名 MSIX 再生成（CI run `31077160621`、artifact `funkot-player-windows-msix`）
- [ ] F. Partner Center 提出（節 F のクリック順。**スクショ撮影は Windows 実機が必要**）
- [ ] G. 認証通過後の実機確認（Store インストール → Music → 再生）

---

## まずここへ（ログインしたのに誘導が無いとき）

Partner Center のトップ（`partner.microsoft.com/dashboard`）は **商用パートナー・Office・Windows など複数ワークスペースの寄せ集め**で、Store アプリ提出の導線は出ないことが多い。  
**ホームで迷ったら、次の直リンクを使う（公式ドキュメントもこれを案内している）。**

| 用途 | URL |
|---|---|
| **Windows アプリ提出の入口（最重要）** | https://aka.ms/submitwindowsapp |
| Store 個人開発者の新規登録フロー | https://storedeveloper.microsoft.com |
| Partner Center ダッシュボード一般 | https://partner.microsoft.com/dashboard |

画面に出る英語ラベルと日本語ラベルの対応（UI 言語で切り替わる）:

| 英語 | 日本語（目安） |
|---|---|
| Apps and games | アプリとゲーム |
| New product | 新しい製品 |
| MSIX or PWA app | MSIX または PWA アプリ |
| EXE or MSI app | EXE または MSI アプリ |
| Check availability | 使用可能か確認 |
| Reserve product name | 製品名の予約 |
| Start submission | 申請の開始 / 提出を開始 |
| Product identity / View product identity | 製品 ID / 製品 ID の表示 |
| Package/Identity/Name | （そのまま英数字） |
| Package/Identity/Publisher | （`CN=...`） |

公式手順の正本:

- [Get started with Microsoft Store](https://learn.microsoft.com/windows/apps/publish/get-started)
- [MSIX アプリの名前を予約する](https://learn.microsoft.com/ja-jp/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)
- [個人開発者アカウントを開く](https://learn.microsoft.com/windows/apps/publish/partner-center/open-a-developer-account)
- [製品の管理とサービス（Identity の場所）](https://learn.microsoft.com/ja-jp/windows/apps/publish/product-management-and-services)

---

## A. Partner Center 個人開発者登録

方針: **個人（Individual）**。組織（Company）は不要。Azure Artifact Signing / 自前 Authenticode は使わない。  
個人向けの登録料は現行フローでは無料になっている（[Windows Developer Blog, 2025-09](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)）。国・本人確認は画面の指示を優先。

### A-1. 登録がまだ終わっていない場合

1. https://storedeveloper.microsoft.com を開く（**ここが現行の個人登録の正規入口**。Partner Center 直入りや VS 経由は古いフローになることがある）。
2. **Get started for free**（無料で開始）を押す。
3. **Individual developer**（個人開発者）を選ぶ。**Company は選ばない。**
4. 使う **個人 Microsoft アカウント（MSA）** でサインインする（会社の Entra / work アカウントは避けた方が安全。Apps and games が見えなくなる事例がある）。
5. 本人確認（政府発行 ID + セルフィー）を完了する。
6. プロフィールを確認し、セットアップ完了後 **Go to Partner Center dashboard** を押す。
7. アカウント選択では **登録に使った同じ MSA** を選ぶ。

### A-2. 「ログインできたが何も無い」場合の確認

成功していると、次のいずれかが見えるはず:

- ホームに **Apps and games / アプリとゲーム** のタイル
- または左ナビに同じ項目
- 直リンク https://aka.ms/submitwindowsapp が **Access restricted でなく** アプリ一覧／概要を出す

見えないときの切り分け（上から）:

1. **直リンク** https://aka.ms/submitwindowsapp を開く（ホームを歩き回らない）。
2. 数分待ってリロード（登録直後は反映待ちがある、と公式に記載あり）。
3. 別ブラウザ／シークレット、キャッシュ削除。
4. **Settings（歯車）→ Account settings → My access** で権限を確認。
5. アカウントが **deactivated** や Access restricted なら、Store 開発者登録が未完了か停止中。再度 https://storedeveloper.microsoft.com から個人登録を完走する。
6. 会社テナントに紐づいた work アカウントで入っている場合は、**個人 MSA** で入り直す。

ここまでで「アプリとゲーム」に入れたら A は完了。次は B。

---

## B. アプリ名予約（MSIX）— 画面クリック順

### B-1. 製品を作る

1. https://aka.ms/submitwindowsapp を開く（またはホームの **アプリとゲーム**）。
2. **新しい製品 / New product** をクリック。
3. 種類を選ぶ画面で **MSIX または PWA アプリ / MSIX or PWA app** を選ぶ。
   - **EXE または MSI アプリは選ばない**（自前署名インストーラ向け。今回の方針と違う）。
   - **Game** も選ばない（Funkot はアプリ）。
4. 名前入力欄に `Funkot`（または希望名）を入れる。
5. **使用可能か確認 / Check availability** を押す。
   - 緑のチェック → 使える。
   - 使用中 → 別名を試す（Store に出ていなくても他人が予約済みのことがある）。
6. **製品名の予約 / Reserve product name** を押す。
7. 成功すると **アプリケーションの概要（Application overview）** に飛ぶ。ここまでで「製品」が 1 つできた状態。

予約は最大おおよそ **3 か月**使わないと解除される、と公式にある。提出草稿を進めれば実質キープできる。

### B-2. Identity（manifest に入れる値）を控える

名前予約の直後でも、概要ページの左ナビから取れる。

1. 左ナビの **製品管理 / Product management** を展開する。
2. **製品 ID / Product identity**（または概要の **View product identity / 製品 ID の表示**）を開く。
3. 次を **一字一句そのまま** メモする（コピペ推奨）:

| Partner Center のラベル | `Package.appxmanifest` のどこ | 例 |
|---|---|---|
| **Package/Identity/Name** | `<Identity Name="...">` | `XXXXXXX.Funkot` |
| **Package/Identity/Publisher** | `<Identity Publisher="...">` | `CN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| **Package/Properties/PublisherDisplayName** | `<PublisherDisplayName>` | 個人名など |

4. これらの文字列は **秘密ではない**（パッケージに埋め込まれる）。メモして節 C で manifest に貼る。

（任意）概要の **Product release** 付近に **Start submission / 申請の開始** がある。押すと提出ドラフトができるが、**Identity 差し替え前にパッケージを上げなくてよい**。ドラフト作成だけ先にやっても構わない。提出本体は節 F。

---

## C. Identity を manifest に反映

編集ファイル: [`packaging/msix/Package.appxmanifest`](../packaging/msix/Package.appxmanifest)

1. `<Identity>` を Partner Center の値に合わせる:

```xml
<Identity
  Name="（Partner Center の Identity Name）"
  Publisher="CN=（Partner Center の Publisher GUID）"
  Version="0.1.2.0"
  ProcessorArchitecture="x64" />
```

2. 必要なら `<Properties>` の `PublisherDisplayName` も Partner Center の表示名に合わせる。
3. **Version** は Store 向け 4 部版数。初回は `0.1.1.0` でよい。以後 Store 更新のたびに上げる（例: `0.1.2.0`）。アプリの semver `0.1.2` と揃える。
4. 変更をコミットして `main` に push する（次の CI がこの manifest を焼く）。

仮のまま提出しないこと。現行 Identity（Partner Center 反映済み）:

- Name=`hatsuboshi.jp.Funkotplayer`
- Publisher=`CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`
- PublisherDisplayName=`hatsuboshi.jp`

---

## D. プライバシーポリシーを一般公開する

提出フォームに **HTTPS で誰でも開ける URL** が必要。正本はリポジトリの `docs/privacy.md`（HTML は `docs/privacy.html`）。

### 現在の提出用 URL（済み・GitHub Pages）

リポジトリは **public**。Pages（GitHub Actions）で `docs/` を公開している。

**Partner Center に貼る URL:**

https://yasuyuki.github.io/funkot-player/privacy.html

予備（以前の gist）: https://gist.github.com/yasuyuki/2bcd2f2737dd02e1622b2e593c258ade  
文面を変えたら `docs/privacy.md` / `privacy.html` を直し、`main` に push（または Docs Pages を再実行）。

### Pages の再デプロイ

1. GitHub → Settings → Pages → Source が **GitHub Actions** であること。
2. Actions → **Docs Pages** → **Run workflow**、または `docs/**` を push。

### 将来のポリシー変更（可能・推奨）

**変更自体は可能で、Store ポリシー上も最新化が求められる**
（[Store Policies 10.5.1](https://learn.microsoft.com/windows/apps/publish/store-policies#105-personal-information): 機能追加に合わせて privacy policy を up-to-date に保つこと）。

| 変えたいもの | 手続き | Partner Center 再提出 |
|---|---|---|
| **同じ URL の文面だけ**（誤記修正・説明の明確化・最終更新日） | `docs/privacy.md` + `privacy.html` を編集 → `main` push（Pages 反映） | **不要**（掲載 URL はそのまま）。データ取り扱いが変わらない場合 |
| **公開 URL 自体を変更** | 新 URL を用意 → 提出の Properties で Privacy policy URL を差し替え | **要**（更新提出） |
| **実際のデータ取り扱いが変わる**（収集開始、外部送信、同意フロー変更など） | ① ポリシー文面を実態に合わせて更新 ② アプリ側の同意・オプトアウト等を Store Policies 10.5 に合わせる ③ 必要なら Properties の「個人情報を扱うか」宣言も見直し ④ パッケージ／提出を更新 | **要**（認証に回る） |

制約・注意:

- URL は常に **一般公開の HTTPS** で到達可能であること（404・ログイン必須は不可）。
- 文面は「何を取得・送信・保存するか／使い方／共有先／ユーザーの制御」を実態どおり書くこと。虚偽や過少記載は認証失敗・削除の対象になりうる。
- Microsoft はデフォルトのプライバシーポリシーを提供しない。**法的義務は開発者側**（適用される個人情報保護法など）。
- Desktop / full-trust 系は個人情報へのアクセス可能性から、**ポリシー維持が事実上必須**になりやすい。
- 収集を増やさない軽い文言修正なら Pages 更新だけで足りる。収集を始める・外部送信を足すなら「文面だけ」では足りず、アプリと提出の両方が対象。

---

## E. 未署名 MSIX を取得する

**Identity 差し替え後**に実施する。差し替え前の artifact は提出に使わない。

### 方法 1: CI（推奨）— Identity 反映後は再実行済み

最新の成功例: Actions run [31077160621](https://github.com/yasuyuki/funkot-player/actions/runs/31077160621)  
artifact **`funkot-player-windows-msix`**（Identity = Partner Center 値）。

追加で焼くとき:

1. GitHub → Actions → **Windows MSIX**（`.github/workflows/windows-msix.yml`）。
2. **Run workflow**:
   - branch: `main`（Identity 反映済み）
   - `engine_ref`: 既定 `player/v0.1.1` でよい（変える場合は意図したタグ／コミット）
3. 成功後、artifact **`funkot-player-windows-msix`** をダウンロードする。
4. 中身の例: `Funkot_0.1.2.0_x64.msix`（版数が変わっていればファイル名も変わる）。
5. このファイルを **そのまま** Partner Center にアップロードする（自分で署名しない）。

### 方法 2: ローカル Windows

前提: Node / Rust / Windows SDK（`makeappx`）。詳細は `packaging/msix/README.md`。

```powershell
cd path\to\funkot-player
npm ci
.\packaging\msix\scripts\pack-msix.ps1
```

出力: `packaging\msix\out\Funkot_0.1.2.0_x64.msix`

### （任意）提出前のサイドロード試験

Store 提出物（未署名）をそのままダブルクリックすると、App Installer が
「publisher certificate could not be verified」で止まる。**これは正常。**

ローカルで動かす手順は [`packaging/msix/README.md`](../packaging/msix/README.md) の
**Optional: local self-sign**（Publisher CN 一致の自己署名＋Trusted People）。
確認項目は節 G と同じ（Music フォルダを開く → 配置 → 再スキャン → 再生）。
スクショ撮影も自己署名インストール後か、**MSIX から出した exe 直実行**
（`packaging/msix/README.md` の Fastest local run）／NSIS で撮ってよい。

---

## F. Partner Center へ提出（クリック順・記入値）

エージェントは Partner Center にログインできない。**ここから先はブラウザ操作**。  
提出物の準備は済み: 未署名 MSIX・privacy URL・説明文・認証メモ。

入口: https://aka.ms/submitwindowsapp → 製品 **Funkot**（予約済み）を開く。

### F-0. 提出ドラフトを開く

1. アプリ概要で **Start submission / 申請の開始**（または既存ドラフトの **Resume / 続行**）。
2. チェックリストの各項目が揃うまで埋め、最後に **Submit for certification / 認証のために提出**。

### F-1. Packages（パッケージ）

1. **Packages** を開く。
2. 次のいずれかの **未署名** `.msix` をアップロードする（自己署名しない）:
   - CI artifact: `main` の最新 `windows-msix` run → `funkot-player-windows-msix`（**この提出の版数の run**。古い run を使わない）
   - ローカルコピー（gitignore）: `packaging/msix/out/Funkot_0.1.2.0_x64.msix`
3. 検証エラーが無いか確認。Identity は次と一致していること:
   - Name=`hatsuboshi.jp.Funkotplayer`
   - Publisher=`CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`

### F-2. Properties（プロパティ）

| 項目 | 記入値 |
|---|---|
| Category | **Music & videos**（音楽とビデオ）／プレイヤー寄りのサブがあれば選択 |
| Privacy policy URL | `https://yasuyuki.github.io/funkot-player/privacy.html` |
| 個人情報を扱うか | ローカル再生中心。解析キャッシュ・意見 ZIP は端末内。**Yes を求められたら Yes** し、上記 URL を必須入力（full-trust は Yes 扱いになることが多い） |
| Website（任意） | `https://github.com/yasuyuki/funkot-player` |
| Support | `https://github.com/yasuyuki/funkot-player/issues` または常用メール |

### F-3. Age ratings（年齢）

アンケートに**実態どおり**回答。Funkot の目安:

- アカウント／SNS／チャット／ユーザー間通信: **なし**
- アプリ内課金・ギャンブル・暴力・性的表現: **なし**
- ユーザーが自分の音源を置く: **ユーザー提供コンテンツあり**（他者公開の掲示板ではない）
- 広告・位置情報追跡: **なし**

生成されたレーティングを確認して保存。

### F-4. Pricing and availability

| 項目 | 目安 |
|---|---|
| 価格 | **無料** |
| マーケット | まず **日本**、または公開したい国すべて |
| 公開タイミング | 認証後すぐ／手動公開は好みで |

### F-5. Store listings（一覧）

言語は最低 **日本語**（英語は任意）。必須は説明文＋スクショ 1 枚以上（**4 枚推奨**）。

**説明（コピー用）:**

```text
Funkot は、端末内の曲をつないで再生する Auto-DJ プレイヤーです。アカウント不要。初回は「Musicフォルダを選ぶ」で既存のフォルダを指定してください（ファイルはコピーしません）。選んだあと「Musicフォルダを開く」で中身を確認し、必要なら再スキャンしてください。
```

**機能・短い箇条書き（任意）:**

```text
- 端末内の曲をつないで連続再生
- 初回は Musicフォルダを選ぶが必須（コピーしない）
- 設定後は ⋮ → Musicフォルダを開く / 変更
- アカウント不要・ローカル再生
```

**スクリーンショット（Desktop）:**

- PNG、**1366×768 以上**（4K 可）、1 ファイル 50 MB 以下
- 最低 1、推奨 4。ロゴや宣伝ステッカーを重ねない
- Windows 実機でアプリを起動して撮影（開発用 NSIS／自己署名 MSIX／`tauri` 実行いずれでも可）
- 推奨カット: (1) 再生中 (2) ライブラリ (3) ⋮ メニュー (4) Music フォルダを開いた直後の Explorer でも可だが、アプリ UI 主体が無難

スクショが無いと提出できない。**未撮影ならここで Windows 側で撮ってから続ける。**

### F-6. Submission options（認証メモ）

**Notes for certification** に貼る:

```text
- On first desktop launch there is no default Music library root and no demo seed. Start stays disabled until the tester picks a folder.
- Required path for certification: use 「Musicフォルダを選ぶ」 / Pick Music folder (empty-state primary button or ⋮). Point at a folder that already has audio (≥2 tracks to Start). Files are not copied or moved; that folder becomes the library scan root. Then ⋮ → 再スキャン (Rescan) if needed.
- After a folder is set: 「Musicフォルダを変更」 / Change Music folder, and 「Musicフォルダを開く」 / Open Music folder (Explorer) to inspect or add files.
- Supported audio examples: wav/mp3/flac/m4a/ogg.
- Local playback only; no account. Feedback ZIP stays on device until the user shares it.
- Desktop full-trust (runFullTrust) for audio and file access.
- WebView2 Evergreen Runtime is expected on the PC (not bundled in the MSIX).
- Privacy policy: https://yasuyuki.github.io/funkot-player/privacy.html
```

### F-7. 提出

1. チェックリストがすべて完了マークになること。
2. **Submit for certification**。
3. パッケージ検証・認証の結果をメール／ダッシュボードで待つ。
4. 公開後に節 G。

### 提出後

1. パッケージ検証エラー → Identity・版数・必須アセットを見直す。
2. 認証失敗 → レポートの指摘を直し再提出。
3. 公開（Release）まで進めたら節 G。

---

## G. 公開後の実機確認

Smart App Control に阻まれないことと、Music 配置 UX を確認する。

1. **Microsoft Store** から Funkot をインストールする（NSIS / GitHub の exe ではない）。
2. 起動する。
3. **Musicフォルダを選ぶ**（ライブラリ上または ⋮）— 既存の音声フォルダを指定し、ライブラリに出ること（コピーされないこと）。
4. （任意）**⋮ → Musicフォルダを開く** — Explorer が開き、現在の Music パスが見えること。
5. 必要なら **再スキャン**する。
6. ライブラリに曲が出ること、**1 曲以上再生**できることを確認する。
7. （任意）ウィンドウを開いたまま再生が続くこと、Smart App Control のブロックが出ないこと。

失敗時の切り分け:

- フォルダを選べない → ダイアログ／権限。設定済みなら「開く」でパスを確認。
- 曲が無い → 再スキャン前か、選んだフォルダと違う場所を見ている。
- 起動しない／WebView2 → Evergreen Runtime の有無を確認。

---

## 説明文ドラフト（コピー用）

Partner Center の Store 一覧用。日本語だけで提出可。英語は任意。

### 短い説明（サブタイトル／短い説明欄がある場合・約1〜2文）

```text
端末内の曲をつないで再生する Auto-DJ プレイヤー。アカウント不要。
```

### 説明（本文）

```text
Funkot は、端末の曲を DJ 風のつなぎで連続再生するプレイヤーです。デッキ操作やビートマッチは不要。「Musicフォルダを選ぶ」で既存フォルダを指定すれば（ファイルはコピーしません）、あとは再生するだけです。

■ はじめかた
1. 「Musicフォルダを選ぶ」（ライブラリまたは ⋮）で音声があるフォルダを指定
2. 必要なら「再スキャン」または再生開始
3. （任意）「Musicフォルダを開く」で選んだフォルダを Explorer 表示し、そこへファイルを追加してもよい

■ できること
・指定した Music フォルダ内の曲をループでつなぎ再生
・キューの追加・並び替え・削除（再開後も維持）
・つなぎ位置（intro / outro）の手直し
・「このつなぎは不適切」でフィードバックを残せる
・意見データは ZIP として端末に保存（自動アップロードなし）

■ 注意
・アカウント登録やクラウド同期はありません。再生は端末内のみです。
・フォルダ選択ではファイルを移動・コピーしません。スキャン対象の根だけ変わります。
・再生には WebView2（通常は Windows に付属）が必要です。

つなぎの感覚について意見を集め、より自然な連続再生にしていくためのアプリです。気になるつなぎがあれば「このつなぎは不適切」から教えてください。
```

### アプリの機能（Features・1行ずつ・最大あたり Partner Center の件数に合わせて削る）

```text
端末内の曲をつないで連続再生
アカウント不要・ローカル再生のみ
Musicフォルダを選ぶで既存フォルダをスキャン（コピーしない）
⋮ → Musicフォルダを開く で選んだフォルダを表示（任意）
キューの編集とセッション維持
intro / outro の手直し
不適切なつなぎのフラグと意見 ZIP
```

### このバージョンの新機能（任意・初回は空でも可）

```text
Microsoft Store 向け初回公開（0.1.1）。Music フォルダを開く導線と、ローカルでのつなぎ再生に対応しています。
```

### English（任意）

**Short:**
```text
On-device Auto-DJ player. No account. Drop tracks in Music and play.
```

**Description:**
```text
Funkot plays the tracks in your on-device Music folder back-to-back with DJ-style transitions. No decks, no beatmatching — prepare a folder and hit play.

Getting started
1. Use Musicフォルダを選ぶ (Pick Music folder) to point at a folder with audio (files are not copied)
2. Rescan or start playback
3. Optional: Open Music folder in Explorer to inspect or copy into the default Music path

Highlights
• Continuous transitions across your library
• Queue edit and session restore
• Correct intro/outro bar counts
• Flag bad transitions; feedback ZIP stays on device until you share it

Local playback only. No account and no automatic upload. WebView2 (usually already on Windows) is required.
```

---

## 版数の上げ方（2 回目以降の Store 更新）

1. アプリの版数（`tauri.conf.json` / Cargo / Android など、既存のリリース手順）を上げる。
2. `Package.appxmanifest` の `Identity Version` を 4 部で上げる（例: `0.1.2.0`）。**前回提出より大きいこと。**
3. `main` に push → `windows-msix` を再実行 → 新しい未署名 MSIX を提出。

---

## やらないこと（方針）

- Azure Artifact Signing / 商用 OV・EV での NSIS 署名
- Store 提出 MSIX への自己署名
- GitHub Release の NSIS をエンドユーザー向け本配布に戻すこと
- Music を Documents 等へ移す大きなパス設計変更（当面は「開く」で緩和）

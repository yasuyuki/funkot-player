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
- [x] C. `Package.appxmanifest` の Identity 差し替え（反映済み・コミット待ち可）
  - Name=`hatsuboshi.jp.Funkotplayer`
  - Publisher=`CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`
  - PublisherDisplayName=`hatsuboshi.jp`
- [ ] D. プライバシーポリシーの一般公開 URL
- [ ] E. Identity 反映後の未署名 MSIX 再生成
- [ ] F. 提出セット（年齢・スクショ・説明・連絡先・パッケージ）
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
  Version="0.1.1.0"
  ProcessorArchitecture="x64" />
```

2. 必要なら `<Properties>` の `PublisherDisplayName` も Partner Center の表示名に合わせる。
3. **Version** は Store 向け 4 部版数。初回は `0.1.1.0` でよい。以後 Store 更新のたびに上げる（例: `0.1.2.0`）。アプリの semver `0.1.1` と揃える。
4. 変更をコミットして `main` に push する（次の CI がこの manifest を焼く）。

仮のまま提出しないこと。現行 Identity（Partner Center 反映済み）:

- Name=`hatsuboshi.jp.Funkotplayer`
- Publisher=`CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`
- PublisherDisplayName=`hatsuboshi.jp`

---

## D. プライバシーポリシーを一般公開する

提出フォームに **HTTPS で誰でも開ける URL** が必要。正本はリポジトリの `docs/privacy.md`（HTML は `docs/privacy.html`）。

### 推奨: GitHub Pages

リポジトリが **private** でも Pages を公開できる場合があるが、組織・プラン制限で非公開のままになることがある。届かないときは後述の代替へ。

1. GitHub → リポジトリ `yasuyuki/funkot-player` → **Settings** → **Pages**。
2. **Build and deployment** → Source を **GitHub Actions** にする。
3. まだデプロイしていない場合:
   - Actions → workflow **Docs Pages**（`.github/workflows/pages-docs.yml`）→ **Run workflow**、または
   - `docs/` か workflow を触って `main` に push。
4. デプロイ成功後、次をブラウザのシークレットウィンドウ等で開けるか確認する:

   `https://yasuyuki.github.io/funkot-player/privacy.html`

5. Partner Center のプライバシーポリシー欄に **この URL** を貼る。

### 代替（Pages が一般公開できない場合）

同じ文面を次のいずれかに置き、その URL を提出に使う:

- 公開 gist（`privacy.md` 相当を HTML または raw で読める形）
- 既存の個人サイトの静的ページ
- 一時的な公開リポジトリに `privacy.html` だけ置く

文面を変えたら **正本 `docs/privacy.md` も同期**し、公開先を更新する。

---

## E. 未署名 MSIX を取得する

**Identity 差し替え後**に実施する。差し替え前の artifact は提出に使わない。

### 方法 1: CI（推奨）

1. GitHub → Actions → **Windows MSIX**（`.github/workflows/windows-msix.yml`）。
2. **Run workflow**:
   - branch: `main`（Identity 反映済み）
   - `engine_ref`: 既定 `player/v0.1.1` でよい（変える場合は意図したタグ／コミット）
3. 成功後、artifact **`funkot-player-windows-msix`** をダウンロードする。
4. 中身の例: `Funkot_0.1.1.0_x64.msix`（版数が変わっていればファイル名も変わる）。
5. このファイルを **そのまま** Partner Center にアップロードする（自分で署名しない）。

### 方法 2: ローカル Windows

前提: Node / Rust / Windows SDK（`makeappx`）。詳細は `packaging/msix/README.md`。

```powershell
cd path\to\funkot-player
npm ci
.\packaging\msix\scripts\pack-msix.ps1
```

出力: `packaging\msix\out\Funkot_0.1.1.0_x64.msix`

### （任意）提出前のサイドロード試験

Store 提出物とは別に、自己署名してローカルインストールしてよい（手順は `packaging/msix/README.md` の Optional）。確認項目は節 G と同じ（Music フォルダを開く → 配置 → 再スキャン → 再生）。

---

## F. Partner Center へ提出

ダッシュボードで予約済みアプリを開き、提出（サブミッション）を作成する。画面ラベルは Microsoft の UI 更新で多少変わる。足りない項目はバリデーションで指摘される。

### 必須に近いもの

| 項目 | 内容の目安 |
|---|---|
| パッケージ | 節 E の **未署名** `.msix` |
| プライバシーポリシー URL | 節 D で確認した URL |
| 年齢レーティング | アンケートに正直に回答（音楽プレイヤー・ユーザー提供コンテンツ） |
| 価格 | 無料可 |
| マーケット | 公開したい国・地域 |
| 説明文 | 日本語だけで可。英語は任意 |
| スクリーンショット | **4 枚以上推奨**（再生画面・メニュー・Music 配置のイメージなど） |
| サポート連絡先 | メールまたは Issues URL など Partner Center が要求する形式 |
| カテゴリ | 音楽／プレイヤー系 |

### Notes for certification（認証メモ）例

審査担当向けに英語で短く書いてよい:

```text
- Music files are added by the user. In the app, open ⋮ → Musicフォルダを開く
  (Open Music folder), copy audio files there, then Rescan.
- Local playback only; no account. Feedback ZIP stays on device until the user shares it.
- Desktop full-trust (runFullTrust) for audio and file access.
- WebView2 Evergreen Runtime is expected on the PC (not bundled in the MSIX).
```

### 提出後

1. パッケージ検証エラーが出たら、Identity 不一致・版数・必須アセットを見直す。
2. 認証（Certification）に回ったら結果メール／ダッシュボードを待つ。
3. 公開（Release）まで進めたら、別 PC またはクリーンユーザーで節 G を実施する。

---

## G. 公開後の実機確認

Smart App Control に阻まれないことと、Music 配置 UX を確認する。

1. **Microsoft Store** から Funkot をインストールする（NSIS / GitHub の exe ではない）。
2. 起動する。
3. **⋮ → Musicフォルダを開く** — Explorer が開き、実際の Music パスが見えること。
4. そのフォルダに音声ファイル（対応形式）をコピーする。
5. アプリで **再スキャン**する。
6. ライブラリに曲が出ること、**1 曲以上再生**できることを確認する。
7. （任意）ウィンドウを開いたまま再生が続くこと、Smart App Control のブロックが出ないこと。

失敗時の切り分け:

- Music が開けない → パッケージ化・仮想化パス。メニュー経由か再確認。
- 曲が無い → 再スキャン前か、コピー先がメニューで開いたフォルダと違う。
- 起動しない／WebView2 → Evergreen Runtime の有無を確認。

---

## 説明文ドラフト（コピー用・任意）

Partner Center の説明欄用。必要に応じて短くする。

**日本語（短文）:**

> Funkot は、端末内の Music フォルダにある曲をつないで再生する Auto-DJ プレイヤーです。アカウント不要。曲の追加はアプリのメニュー「Musicフォルダを開く」からフォルダを開き、ファイルを置いて再スキャンしてください。

**English (short):**

> Funkot is an on-device Auto-DJ music player. No account. Add tracks via ⋮ → Open Music folder, then rescan.

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

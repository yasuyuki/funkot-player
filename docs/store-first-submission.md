# Microsoft Store 初回提出

Partner Center の登録、アプリ名予約、Identity の初回反映、プライバシー URL の公開。
**2 回目以降の Store 更新は [store-submission.md](store-submission.md)。**

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
   （確認手順は store-submission.md「公開後の実機確認」）
```

順序の注意:

- **3 の前に 2**（Publisher / Name が無いと提出で弾かれる）
- **Identity 差し替え後は必ず MSIX を作り直す**（仮 Identity の artifact は提出に使わない）
- **4 の URL** は提出フォーム必須。private リポジトリのまま Pages が届かない場合は代替 URL を用意する

---

## 進捗チェックリスト

初回提出時点の記録。以降の更新は [store-submission.md](store-submission.md)。

### リポジトリ側（済み）

- [x] `⋮ → Musicフォルダを開く`（配置 UX）
- [x] `docs/privacy.md` / `privacy.html`
- [x] `packaging/msix/`（manifest + `pack-msix.ps1`）
- [x] CI `windows-msix`（artifact `funkot-player-windows-msix`）

### 人が行う

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
- [x] F. Partner Center 初回提出

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
3. **Version** は Store 向け 4 部版数。初回は `0.1.1.0` でよい。以後の上げ方は [store-submission.md](store-submission.md)。アプリの semver と揃える。
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
文面を変えたら `docs/privacy.md` / `privacy.html` を直し、`main` に push（または Docs Pages を再実行）。ポリシー変更が再提出になるかは [store-submission.md](store-submission.md)「プライバシーポリシーを変えるとき」。

### Pages の再デプロイ

1. GitHub → Settings → Pages → Source が **GitHub Actions** であること。
2. Actions → **Docs Pages** → **Run workflow**、または `docs/**` を push。

---

## E. 未署名 MSIX を取得する

**Identity 差し替え後**に実施する。差し替え前の artifact は提出に使わない。
以降の版で焼く手順は [store-submission.md](store-submission.md)「未署名 MSIX」。

初回 Identity 反映後の成功例: Actions run [31077160621](https://github.com/yasuyuki/funkot-player/actions/runs/31077160621)  
artifact **`funkot-player-windows-msix`**（Identity = Partner Center 値）。

---

## F. Partner Center へ初回提出（クリック順・記入値）

エージェントは Partner Center にログインできない。**ここから先はブラウザ操作**。

入口: https://aka.ms/submitwindowsapp → 製品 **Funkot**（予約済み）を開く。

一覧の本文・新機能のコピーは [store-submission.md](store-submission.md)「説明文ドラフト」。初回は **全部**埋める（Properties / Age ratings / Pricing / listings / スクショ / 認証メモ）。2 回目以降はパッケージと「このバージョンの新機能」が主で、変わっていない欄は触らない。

### F-0. 提出ドラフトを開く

1. アプリ概要で **Start submission / 申請の開始**。
2. チェックリストの各項目が揃うまで埋め、最後に **Submit for certification / 認証のために提出**。

### F-1. Packages（パッケージ）

1. **Packages** を開く。
2. **未署名** `.msix` をアップロードする（自己署名しない）。Identity は次と一致していること:
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

言語はアプリ UI と同じ **日本語・英語・インドネシア語** の3つ。コピーは [store-submission.md](store-submission.md)「説明文ドラフト」。
必須は各言語で説明文＋スクショ 1 枚以上（**4 枚推奨**）。日本語で撮ったスクショを
英語・インドネシア語へ流用してよい。新機能文の対象 OS も同じ節。

**スクリーンショット（Desktop）:**

- PNG、**1366×768 以上**（4K 可）、1 ファイル 50 MB 以下
- 最低 1、推奨 4。ロゴや宣伝ステッカーを重ねない
- Windows 実機でアプリを起動して撮影（開発用 NSIS／自己署名 MSIX／`tauri` 実行いずれでも可）
- 推奨カット: (1) 再生中 (2) ライブラリ (3) ⋮ メニュー (4) Music フォルダを開いた直後の Explorer でも可だが、アプリ UI 主体が無難

スクショが無いと提出できない。**未撮影ならここで Windows 側で撮ってから続ける。**

### F-6. Submission options（認証メモ）

**Notes for certification** は [store-submission.md](store-submission.md)「認証メモ」。

### F-7. 提出

1. チェックリストがすべて完了マークになること。
2. **Submit for certification**。
3. パッケージ検証・認証の結果をメール／ダッシュボードで待つ。
4. 公開後の確認は [store-submission.md](store-submission.md)「公開後の実機確認」。

### 提出後

1. パッケージ検証エラー → Identity・版数・必須アセットを見直す。
2. 認証失敗 → レポートの指摘を直し再提出。
3. 公開（Release）まで進めたら「公開後の実機確認」。

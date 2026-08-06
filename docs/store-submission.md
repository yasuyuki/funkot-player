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

- [ ] A. Partner Center 個人開発者登録
- [ ] B. アプリ名予約（**MSIX アプリ**）
- [ ] C. `Package.appxmanifest` の Identity 差し替え＋コミット
- [ ] D. プライバシーポリシーの一般公開 URL
- [ ] E. Identity 反映後の未署名 MSIX 再生成
- [ ] F. 提出セット（年齢・スクショ・説明・連絡先・パッケージ）
- [ ] G. 認証通過後の実機確認（Store インストール → Music → 再生）

---

## A. Partner Center 個人開発者登録

1. ブラウザで [Partner Center](https://partner.microsoft.com/dashboard) を開く。
2. Microsoft アカウントでサインインする。
3. **個人**開発者として登録する（料金・本人確認は画面の指示に従う。国・支払いは Microsoft の現行案内を優先）。
4. 登録完了後、ダッシュボードに入れることを確認する。

メモ: 組織アカウントは不要（方針は個人開発者）。Azure Artifact Signing / 自前 Authenticode は使わない。

---

## B. アプリ名予約（MSIX）

1. Partner Center → **アプリとゲーム**（または同等の「新しい製品」）。
2. **新しいアプリ**を作成するとき、種類は **MSIX または PWA アプリ** を選ぶ。
   - **EXE / MSI（クラシック）ではない。** 間違えると後でパッケージ種別が合わない。
3. 表示名を予約する（例: `Funkot`）。空きが無ければ別名を検討。
4. 予約後、次を控える（提出・manifest に必須）:

| 項目 | どこで見るか | 例 |
|---|---|---|
| **Identity Name** | パッケージ ID / 製品の Identity | `XXXX.Funkot` など |
| **Publisher** | 発行元 ID（証明書の Subject） | `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` |
| **Publisher display name** | 発行元の表示名 | 個人名またはブランド名 |

5. 控えた値を安全な場所（メモ・パスワードマネージャ）に保存する。リポジトリに秘密は載せないが、**Identity Name / Publisher 文字列自体は公開されてよい**（manifest に入る）。

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

仮のまま提出しないこと（現状の仮値: `Name="Funkot"` / `Publisher="CN=Funkot"`）。

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

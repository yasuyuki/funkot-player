# Microsoft Store submission checklist (Funkot)

Windows の本配布は **MSIX + Partner Center**。署名は提出後に Microsoft が行う。
未署名 MSIX を上げる（ローカル試験用の自己署名は Store に使わない）。

## 前提（リポジトリ側・済み／準備中）

- [x] `⋮ → Musicフォルダを開く`（配置 UX）
- [x] `docs/privacy.md`
- [x] `packaging/msix/`（manifest + `pack-msix.ps1`）
- [ ] Partner Center 個人開発者登録
- [ ] アプリ名予約（**MSIX アプリ**）
- [ ] `Package.appxmanifest` の Identity **Name** / **Publisher** を予約値に置換
- [ ] プライバシーポリシーを **一般公開 URL** にする（下節）
- [ ] スクリーンショット 4 枚以上、説明文、年齢レーティング
- [ ] 未署名 MSIX をアップロードして認証

## Partner Center

1. https://partner.microsoft.com/dashboard で個人アカウント登録
2. **新しい製品 → MSIX または PWA アプリ**（EXE/MSI ではない）
3. 名前を予約（例: Funkot）
4. 予約後に表示される **Publisher ID**（`CN={GUID}` 形式）と Package/Identity Name を控える
5. `packaging/msix/Package.appxmanifest` を編集:
   - `Identity Name="..."`
   - `Identity Publisher="CN=..."`
6. PowerShell（Windows）:

   ```powershell
   npm ci
   .\packaging\msix\scripts\pack-msix.ps1
   ```

   出力: `packaging/msix/out/Funkot_0.1.1.0_x64.msix`

7. 提出: パッケージ、価格（無料可）、マーケット、年齢、一覧、**プライバシーポリシー URL**
8. Notes for certification 例:
   - Music files are added by the user via ⋮ → Musicフォルダを開く
   - Playback continues while the window is open; no account

## Privacy policy URL

`docs/privacy.md` を公開する。リポジトリが private の場合は次のいずれか:

- GitHub Pages を有効化し、少なくとも `privacy` を public に届ける
- または gist / 別の公開サイトに同じ文面を置く

想定 URL（Pages 有効後）:

`https://yasuyuki.github.io/funkot-player/privacy.html`

CI: `.github/workflows/pages-docs.yml` が `docs/` をデプロイする（リポジトリ Settings → Pages → GitHub Actions を選択）。

## 認証メモ用の製品事実

- ローカル再生のみ。サーバへの自動アップロードなし
- 「意見を送る」は端末内 ZIP をユーザーが共有するまで外に出ない
- `runFullTrust`（デスクトップ音声・ファイルアクセス）

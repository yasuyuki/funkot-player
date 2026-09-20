# Microsoft Store 更新提出

Windows の本配布は **MSIX + Partner Center**。署名は提出後に Microsoft が行う。
**Store に上げる MSIX は未署名**（自己署名はローカル試験専用。`packaging/msix/README.md` 参照）。

初回の登録・名前予約・Identity 反映は [store-first-submission.md](store-first-submission.md)。
技術的なパック手順は [packaging/msix/README.md](../packaging/msix/README.md)。
版数の機械側は `.claude/skills/app-version/SKILL.md`。

入口: https://aka.ms/submitwindowsapp → 製品 **Funkot**。

---

## 手順

1. `./scripts/set-version.sh <X.Y.Z>`。8 ファイルをまとめて書く。**手で個別に直さない。**
   番号は Store に今出ている版より大きいこと。
2. 下の「このバージョンの新機能」三言語を、その版の **共通 + Windows 固有** だけに書き換える。
   見出しの版数も揃える。GitHub Release 本文を流用しない。
3. Partner Center で **今 Store に出ている版数** を確認する。HANDOFF の「認証待ち」は古くなりうる。
   認証中の提出があるなら、終わるか取り消すまで次を出さない。
4. `main` に push する。CI `Checks` が版数の一致と新機能文の対象 OS を見る。
5. `windows-msix` を回す（`workflow_dispatch`、入力なし。sibling は `funkot-core.commit` の
   SHA で checkout される）。その run の未署名 MSIX を取る。
6. Windows で下書きを作る（下の「下書きの自動化」。初回だけ `setup` が要る）:

   ```powershell
   node scripts\store-draft.mjs stage --msix <その run の .msix>
   ```

   版数・三言語の新機能文を照合し、パッケージを上げて listing の新機能を書き、
   **下書きのまま止まる**。`--dry` はブラウザを開かず照合だけする。
7. Partner Center で下書きを目視し、**Submit for certification** を押す。
8. 認証通過後、下の「公開後の実機確認」。

Properties / Age ratings / Pricing / 短い説明 / 説明 / アプリの機能は、
**前回から変わっていなければ触らない。** UI が大きく変わったときだけスクショを差し替える。

---

## 固定値

Identity（パッケージ検証。変えない）:

- Name=`hatsuboshi.jp.Funkotplayer`
- Publisher=`CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`
- PublisherDisplayName=`hatsuboshi.jp`

Privacy policy URL: https://yasuyuki.github.io/funkot-player/privacy.html

---

## 未署名 MSIX

### CI（正）

1. GitHub → Actions → **Windows MSIX**（`.github/workflows/windows-msix.yml`）。
2. **Run workflow**: 提出する版の branch か tag を選ぶ。入力は無く、sibling は
   `funkot-core.commit` の SHA で checkout される。
3. artifact **`funkot-player-windows-msix`** を **この提出の版数の run** から取る。古い run を使わない。
4. 中身（例）`Funkot_0.5.0.0_x64.msix` を **そのまま** アップロードする（自分で署名しない）。

### ローカル Windows

前提: Node / Rust / Windows SDK（`makeappx`）。詳細は `packaging/msix/README.md`。

```powershell
cd path\to\funkot-player
npm ci
.\packaging\msix\scripts\pack-msix.ps1
```

出力: `packaging\msix\out\Funkot_<版>.0_x64.msix`（`$PackageVersion` は `set-version.sh` が書く）。

未署名 MSIX をダブルクリックすると App Installer が証明書エラーで止まる。**これは正常。**
ローカル動作確認は [`packaging/msix/README.md`](../packaging/msix/README.md) の self-sign か exe 直実行。

---

## 下書きの自動化

Partner Center の API は Entra ID の資格情報を要求し、このアカウントはテナントを持たない。
そのため **今の既定はブラウザ経路**で、テナントが取れた時点で API 経路へ移る。
どちらも **Submit for certification は押さない**。

### 今の経路: ブラウザ（[`scripts/store-draft.mjs`](../scripts/store-draft.mjs)）

この repo が既に持つ Playwright で、専用プロファイルの Chromium を動かす。パスワードは扱わない。
サインインは初回だけ人が行い、そのプロファイルに残る。

```powershell
node scripts\store-draft.mjs setup                        # 初回: サインインと各ページ URL の記録
node scripts\store-draft.mjs stage --msix <.msix>         # 下書き作成
node scripts\store-draft.mjs stage --msix <.msix> --dry   # ブラウザを開かず照合だけ
node scripts\store-draft.mjs probe                        # 画面が変わったとき要素を出力する
```

`setup` は Packages と各言語の Store listing の URL を人に開いてもらって記録する。
Partner Center の URL は id を含み、script からは推測できないため。**この URL は submission 単位**
なので、新しい提出を始めたら `setup` をもう一度回す（ページを 4 枚開いて Enter を押すだけ）。
記録が古いと `stage` はその段で止まり、同じことを案内する。

状態は `%LOCALAPPDATA%\funkot-store-draft\` に置く。プロファイルには**サインイン済みの
Microsoft セッション**が入るので、資格情報と同じ扱いにする（repo に入れない、共有しない）。
段が一致しなかったときは screenshot と要素一覧を同じ場所へ残して止まるので、それを見て
selector を直す。Partner Center の UI は変わるので、壊れること自体は想定内とする。

### テナント取得後: msstore（[`scripts/store-publish.ps1`](../scripts/store-publish.ps1)）

Microsoft Store Developer CLI (`msstore`) 経由で Partner Center API を叩く。preview 版で、
**アプリ更新 API は無料アプリのみ**対応（Funkot は無料なので該当する）。**現時点では未使用**で、
下の設定が済むまで動かない。

1. Partner Center に Entra ID テナントを関連付け、そのテナントにアプリ登録を作り、Partner Center 側で
   **Manager** ロールを与える。サインイン自体は個人 MSA のままでよい
   （[store-first-submission.md](store-first-submission.md) の work アカウントの注意を参照）。
2. `winget install Microsoft.DotNet.DesktopRuntime.9` と
   `winget install "Microsoft Store Developer CLI"`。
3. `msstore reconfigure --tenantId … --sellerId … --clientId … --clientSecret …` を**本人が**実行する。

資格情報はローカルの msstore 設定にだけ置く。**この repo は public なので、TenantId / SellerId /
ClientId / ClientSecret を docs にも script にも書かない。** product id は `msstore apps list` から
Identity Name で引くので、通常は指定不要（`-ProductId` で上書きできる）。

script は **Submit for certification を押さない**。認証中・保留中の提出を見つけたら止まり、
`-Force` を付けたときだけ続行する（`msstore publish` は保留中の下書きを作り直すため）。

---

## Partner Center

サインインと **Submit for certification** はブラウザ操作。エージェントはログインできない。
手順 6 の script を使った場合、Packages と「このバージョンの新機能」は下書きに入っている。

1. https://aka.ms/submitwindowsapp → **Funkot** → **Resume**（script が作った下書き）。
   script を使わない場合は **Start submission** し、**Packages** にこの版の未署名 `.msix` を上げ、
   **Store listings** の各言語に下のドラフトの「このバージョンの新機能」を貼る。
2. **Packages** の版数と Identity、各言語の「このバージョンの新機能」が、この版のものか目視する。
3. テスター向けの動きが変わっていれば **Notes for certification** を下の認証メモで更新する。
4. チェックリストが揃ったら **Submit for certification**。

提出後:

1. パッケージ検証エラー → Identity・版数・必須アセットを見直す。
2. 認証失敗 → レポートの指摘を直し再提出。
3. 公開まで進めたら「公開後の実機確認」。

---

## 新機能文の対象

Partner Center の読者は Windows の Store 利用者だけ。書くのは **(1) 全 OS 共通** と
**(2) Windows 固有**。Android 固有（戻るキーでプロセスが死ぬ、通知シェード /
MediaSession、前景サービス、APK）は **GitHub Release 本文**へ。GitHub は Android
APK の配布面なので、そちらに Android の記述を入れてよい。GitHub 本文を Store へ
コピーしない。`./scripts/check-doc-claims.sh` が下の新機能ペースト欄に Android 語が
混ざると落とす。

---

## 公開後の実機確認

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

## プライバシーポリシーを変えるとき

正本は [privacy.md](privacy.md) / [privacy.html](privacy.html)。初回の Pages 公開は
[store-first-submission.md](store-first-submission.md) 節 D。

**変更自体は可能で、Store ポリシー上も最新化が求められる**
（[Store Policies 10.5.1](https://learn.microsoft.com/windows/apps/publish/store-policies#105-personal-information)）。

| 変えたいもの | 手続き | Partner Center 再提出 |
|---|---|---|
| **同じ URL の文面だけ**（誤記修正・説明の明確化・最終更新日） | `docs/privacy.md` + `privacy.html` を編集 → `main` push（Pages 反映） | **不要**（掲載 URL はそのまま）。データ取り扱いが変わらない場合 |
| **公開 URL 自体を変更** | 新 URL を用意 → 提出の Properties で Privacy policy URL を差し替え | **要**（更新提出） |
| **実際のデータ取り扱いが変わる**（収集開始、外部送信、同意フロー変更など） | ① ポリシー文面を実態に合わせて更新 ② アプリ側の同意・オプトアウト等を Store Policies 10.5 に合わせる ③ 必要なら Properties の「個人情報を扱うか」宣言も見直し ④ パッケージ／提出を更新 | **要**（認証に回る） |

制約:

- URL は常に **一般公開の HTTPS**（404・ログイン必須は不可）。
- 文面は実態どおり。虚偽や過少記載は認証失敗・削除の対象になりうる。
- 収集を増やさない軽い文言修正なら Pages 更新だけで足りる。

Pages の再デプロイ: Settings → Pages が GitHub Actions。Actions → **Docs Pages**、または `docs/**` を push。

---

## 認証メモ

**Notes for certification** に貼る（テスター向けの動きが変わったとき更新）:

```text
- On first desktop launch there is no default Music library root and no demo seed. Start stays disabled until the tester picks a folder.
- UI languages: Japanese, English, Indonesian. Cycle from the ⋮ menu (Language: …). Until the tester picks one, the app follows the PC language.
- Required path for certification: use 「Musicフォルダを選ぶ」 / Pick Music folder / Pilih folder Musik (empty-state primary button or ⋮). Point at a folder that already has audio (≥1 track to Start). Files are not copied or moved; that folder becomes the library scan root. Then ⋮ → 再スキャン / Rescan / Pindai ulang if needed.
- After a folder is set: 「Musicフォルダを変更」 / Change Music folder / Ganti folder Musik, and 「Musicフォルダを開く」 / Open Music folder / Buka folder Musik (Explorer) to inspect or add files.
- Supported audio examples: wav/mp3/flac/m4a/ogg.
- Local playback only; no account. Feedback ZIP stays on device until the user shares it.
- Desktop full-trust (runFullTrust) for audio and file access.
- WebView2 Evergreen Runtime is expected on the PC (not bundled in the MSIX).
- Privacy policy: https://yasuyuki.github.io/funkot-player/privacy.html
```

---

## 説明文ドラフト（コピー用）

Partner Center の Store listings。アプリ UI と同じ **日本語・英語・インドネシア語**。
ボタン名は画面どおり（「Musicフォルダを選ぶ」/ “Pick Music folder” / “Pilih folder Musik”）。
更新提出では「このバージョンの新機能」以外は、変わっていなければ貼り直さない。

### 日本語

**短い説明:**
```text
端末内の曲をつないで再生する Auto-DJ プレイヤー。アカウント不要。日本語・英語・インドネシア語。
```

**説明:**
```text
Funkot は、端末の曲を DJ 風のつなぎで連続再生するプレイヤーです。デッキ操作やビートマッチは不要。「Musicフォルダを選ぶ」で既存フォルダを指定すれば（ファイルはコピーしません）、あとは再生するだけです。画面は日本語・英語・インドネシア語で、⋮ から切り替えられます。

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

**アプリの機能:**
```text
端末内の曲をつないで連続再生
アカウント不要・ローカル再生のみ
画面は日本語・英語・インドネシア語（⋮ から切替）
Musicフォルダを選ぶで既存フォルダをスキャン（コピーしない）
⋮ → Musicフォルダを開く で選んだフォルダを表示（任意）
キューの編集とセッション維持
intro / outro の手直し
不適切なつなぎのフラグと意見 ZIP
```

**このバージョンの新機能（0.8.0）:**
```text
曲にアプリ内だけのタグを付けられるようになりました。1曲ずつでもまとめてでも編集でき、付けたタグでライブラリを絞り込めます。音楽ファイルは書き換えません。ファイルに埋め込まれた発売年の読み取りも改善しました。
```

### English

**Short description:**
```text
On-device Auto-DJ player. No account. English, Japanese, and Indonesian.
```

**Description:**
```text
Funkot plays the tracks on your PC back-to-back with DJ-style transitions. No decks, no beatmatching. Use “Pick Music folder” to point at a folder you already have (files are not copied), then hit play. The UI is English, Japanese, or Indonesian; cycle it from the ⋮ menu.

Getting started
1. “Pick Music folder” (library or ⋮) and choose a folder that has audio
2. “Rescan” if needed, or start playback
3. Optional: “Open Music folder” shows that folder in Explorer so you can add files there

What it does
• Loops transitions across tracks in the Music folder you picked
• Add, reorder, and remove queue items (kept after you resume)
• Adjust intro / outro transition points
• Flag “This transition is wrong” to leave feedback
• Feedback data stays on the device as a ZIP until you share it (no automatic upload)

Notes
• No account and no cloud sync. Playback stays on the device.
• Picking a folder does not move or copy files. Only the scan root changes.
• Playback needs WebView2 (usually already on Windows).

The app collects opinions on transitions so continuous playback can feel more natural. If a transition bothers you, tell us with “This transition is wrong”.
```

**App features:**
```text
Continuous transitions across on-device tracks
No account — local playback only
UI in English, Japanese, and Indonesian (cycle from ⋮)
Pick Music folder to scan an existing folder (files are not copied)
⋮ → Open Music folder to show the folder you picked (optional)
Queue edit and session restore
Adjust intro / outro
Flag a bad transition and keep a feedback ZIP
```

**What's new in this version (0.8.0):**
```text
You can now tag tracks inside the app. Edit tags one track at a time or in bulk, and filter the library by a tag. Your music files are never modified. Release years embedded in files are also read more reliably.
```

### Bahasa Indonesia

**Deskripsi singkat:**
```text
Pemutar Auto-DJ yang menyambungkan lagu di perangkat. Tanpa akun. Indonesia, Inggris, dan Jepang.
```

**Deskripsi:**
```text
Funkot memutar lagu di PC secara berkesinambungan dengan transisi bergaya DJ. Tidak perlu dek atau beatmatching. Lewat “Pilih folder Musik”, tunjuk folder yang sudah ada (berkas tidak disalin), lalu tekan putar. Tampilan tersedia dalam bahasa Indonesia, Inggris, dan Jepang; ganti dari menu ⋮.

Mulai
1. “Pilih folder Musik” (pustaka atau ⋮) dan pilih folder yang berisi audio
2. “Pindai ulang” jika perlu, atau mulai pemutaran
3. Opsional: “Buka folder Musik” menampilkan folder itu di Explorer agar berkas bisa ditambah di sana

Yang bisa dilakukan
• Memutar lagu di folder Musik yang dipilih dengan transisi berulang
• Tambah, urutkan, dan hapus antrean (tetap ada setelah dilanjutkan)
• Sesuaikan titik transisi intro / outro
• Tandai “Transisi ini tidak pas” untuk memberi masukan
• Data masukan tersimpan sebagai ZIP di perangkat sampai Anda membagikannya (tanpa unggah otomatis)

Catatan
• Tidak ada akun dan tidak ada sinkronisasi cloud. Pemutaran hanya di perangkat.
• Memilih folder tidak memindahkan atau menyalin berkas. Yang berubah hanya akar pemindaian.
• Pemutaran membutuhkan WebView2 (biasanya sudah ada di Windows).

Aplikasi ini mengumpulkan masukan tentang transisi agar pemutaran berkesinambungan terasa lebih alami. Jika ada transisi yang mengganggu, beri tahu lewat “Transisi ini tidak pas”.
```

**Fitur aplikasi:**
```text
Lagu di perangkat diputar berkesinambungan dengan transisi
Tanpa akun — pemutaran lokal saja
Tampilan bahasa Indonesia, Inggris, dan Jepang (ganti dari ⋮)
Pilih folder Musik untuk memindai folder yang sudah ada (tidak disalin)
⋮ → Buka folder Musik untuk menampilkan folder yang dipilih (opsional)
Sunting antrean dan lanjutkan sesi
Sesuaikan intro / outro
Tandai transisi yang tidak pas dan simpan ZIP masukan
```

**Yang baru di versi ini (0.8.0):**
```text
Kini Anda dapat memberi tag pada lagu di dalam aplikasi. Tag dapat diubah satu per satu atau sekaligus, dan pustaka dapat disaring berdasarkan tag. Berkas musik tidak diubah. Tahun rilis yang tertanam pada berkas juga dibaca lebih andal.
```

---

## やらないこと（方針）

- Azure Artifact Signing / 商用 OV・EV での NSIS 署名
- Store 提出 MSIX への自己署名
- GitHub Release の NSIS をエンドユーザー向け本配布に戻すこと
- Music を Documents 等へ移す大きなパス設計変更（当面は「開く」で緩和）

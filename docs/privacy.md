# プライバシーポリシー / Privacy Policy

**アプリ名:** Funkot  
**最終更新日:** 2026-08-06

開発者への連絡は [GitHub Issues（yasuyuki/funkot-player）](https://github.com/yasuyuki/funkot-player/issues) へ。

## 収集・保存するデータ

Funkot はアカウント登録を求めず、トラッキングや広告のためのデータ収集もしません。

- **音楽ファイル** — 端末内の Music フォルダに置いたファイルだけを再生します。サーバーへアップロードしません。
- **解析キャッシュ・再生キュー・手直し（intro/outro など）** — いずれも端末ローカルに保存します。
- **再生履歴** — どの曲をいつ再生したかを端末ローカルに記録します。アプリ内の「履歴」で見られ、⋮ メニューの「ラベルと再生履歴を消す」で消せます。サーバーへ送信せず、「意見を送る」の ZIP にも含めません。
- **「意見を送る」** — `library.json` / `flags.json` などを ZIP にまとめたファイルは、あなたが共有するまで端末内に留まります。アプリから自動でサーバー送信はしません。

## アンインストール時

アンインストールすると、アプリが保存したデータ（キャッシュ・キュー・手直しなど）が消える場合があります。Music フォルダ内の音源ファイルの扱いも環境により異なります。必要なデータは事前にバックアップしてください。

## English (short)

Funkot stores music, analysis cache, queue, your bar corrections, and a play history (which track was played, and when) on-device only. There is no account, tracking, or ads. The play history is never uploaded and is not part of a feedback ZIP; ⋮ → clear labels and play history deletes it. Feedback ZIPs stay on your device until you share them; the app does not upload them automatically. Uninstalling may remove app data. Contact: GitHub Issues on yasuyuki/funkot-player.

---

このファイルの HTML 版は `docs/privacy.html`。

**Store 提出用の公開 URL:**
https://yasuyuki.github.io/funkot-player/privacy.html

（リポジトリは public。`docs/` を GitHub Pages で配信。文面変更は `main` へ push。）

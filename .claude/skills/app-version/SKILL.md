---
name: app-version
description: funkot-player の版数（アプリのバージョン）を上げる・確認する手順。`./scripts/set-version.sh` で機械化できる部分を一括更新し、機械化できない Windows（Partner Center / MSIX）と Android（APK / versionCode）の作業を順に片付ける。「バージョンを上げる」「版数」「リリース」「MSIX を提出」「APK を焼く」「0.1.x にする」といった依頼、および版数の食い違いを疑うときに使う。
---

# funkot-player の版数を上げる

版数は 8 ファイルに 3 つの形（semver / 4 部 MSIX 形式 / 文章に埋まったファイル名）で
書かれていて、互いにリンクしていない。**手で直すと必ずどれかが取り残される。**
`packaging/msix/scripts/pack-msix.ps1` は `Package.appxmanifest` を読まず自前の
`$PackageVersion` を持つので、マニフェストだけ直すと中身と違う版数の MSIX が焼ける。

機械が書ける場所は `./scripts/set-version.sh` が全部書く。**それ以外を手で直さない。**

## 手順

### 0. 番号を決める（人の判断・機械化できない）

- **提出済みの成果物と同じ番号を再利用しない。** Store 審査中の版があるなら、
  開発線はその先の番号へ進める。同じ番号の二つのビルドは、バグ報告がどちらの
  バイナリから来たか永久に分からなくする
- Partner Center は **前回提出より厳密に大きい** 4 部版数を要求する
- Android の `versionCode` は `major*1000000 + minor*1000 + patch`（`0.1.3` → `1003`）。
  **単調増加が必須。** 下げると端末で `adb install -r` が拒否される
- 現状は `./scripts/set-version.sh`（引数なし）で全部見える

### 1. 一括更新

```sh
./scripts/set-version.sh 0.1.4     # 8 ファイルすべてを書き、そのまま検証
./scripts/set-version.sh --check   # 全部一致しているかだけ見る（書かない）
./scripts/set-version.sh           # 各ファイルの現在値と Android 派生値を表示
```

書き込み後に自動で `--check` が走る。`consistent across 8 files` が出れば通っている。

対象（Windows と Android は上流を共有する）:

| ファイル | 形 | 効く先 |
|---|---|---|
| `package.json` / `package-lock.json` | `0.1.4` | npm |
| `src-tauri/Cargo.toml` / `Cargo.lock` | `0.1.4` | `FUNKOT_VERSION_NAME` / `FUNKOT_VERSION_CODE`（`build.rs`） |
| `src-tauri/tauri.conf.json` | `0.1.4` | **Windows バンドルと Android の両方の上流** |
| `packaging/msix/Package.appxmanifest` | `0.1.4.0` | Store の Identity Version |
| `packaging/msix/scripts/pack-msix.ps1` | `0.1.4.0` | MSIX のファイル名と中身のラベル |
| `packaging/msix/README.md` | `0.1.4.0` | サイドロード手順のコピペコマンド |

**触らないもの**（スクリプトも避けている。手でも直さない）:

- `docs/store-submission.md` の `0.1.2` — **提出した事実の記録**であって次に焼く版ではない
- ワークフローと README の `player/v0.1.1` — これは **funkot-autodj（エンジン）の版**。別物
- `src-tauri/src/store.rs` の `0.1.0` — テスト fixture

### 2. コミットする

`git diff` を読んでから 1 コミットにまとめる。8 ファイル以外が入っていたら止まる。

### 3. Windows（機械化できない部分）

1. **`main` に push する。** CI `Checks` が `set-version.sh --check` を回すので、
   取り残しがあればここで落ちる
2. **`windows-msix` ワークフローを回す。`engine_ref` を必ず明示する。**
   未指定だと `player/v0.1.1` にフォールバックする（`vars.FUNKOT_ENGINE_REF` は未設定）。
   **タグ push 経路は入力欄が出ないので、黙って古いエンジンで焼かれる**
3. artifact `funkot-player-windows-msix` を **その版数の run から** 取る。古い run を使わない
4. Partner Center で提出ドラフトを作り、未署名 MSIX を上げる。
   画面クリック順と記入値の正本は [docs/store-submission.md](../../../docs/store-submission.md)
5. 「このバージョンの新機能」は人が書く。Partner Center 側にしか存在しない

ローカルで焼くなら Windows 側で `.\packaging\msix\scripts\pack-msix.ps1`。
版数はスクリプトが持っているので、手順 1 を済ませてあれば引数は要らない。

### 4. Android（機械化できない部分）

`gen/android/app/tauri.properties`（`versionName` / `versionCode`）は
**`tauri.conf.json` から Tauri の android ビルドが生成する。** gitignore 対象で
`DO NOT EDIT` と書いてある。`set-version.sh` は読んで報告するだけで、書かない。

したがって:

1. 版数を上げただけでは端末上のアプリは変わらない。**android ビルドを回して初めて反映される**

   ```sh
   ./dev.sh npx tauri android build --debug --target aarch64
   ```

   `set-version.sh` が `tauri.properties still says ...` と言う間は、
   その版数の APK はまだ存在しない
2. release APK はローカルでしか焼かない（CI 経路が無い）。焼く前に
   `./scripts/check-release-invariants.sh` を通す
3. `./scripts/install-apk.sh <debug|release>` で入れる（アドレスは自動で引く）。
   **debug と release は署名が違い、役割は端末に固定**。役割と端末の対応は
   この PC の設定側にあり、リポジトリには持たせない。端末まわりの正本は
   skill `android-device`
4. Play Console は未使用。Android 側に提出作業は無い
5. GitHub Release を切るなら **説明文（release body）は英語**。チャットが日本語でも
   本文は英語。Partner Center の「このバージョンの新機能」は日本語のまま

## 版数の食い違いを疑うとき

```sh
./scripts/set-version.sh --check
```

落ちた場合、出力が「どのファイルが何を言っているか」を示す。直し方は
`./scripts/set-version.sh <正しい版数>` を回すだけ。

`no version found` が出たら、そのファイルの書式が変わって
`set-version.sh` のアンカーが当たらなくなっている。**版数ではなくスクリプトを直す。**

## 版数を書く場所が増えたとき

`set-version.sh` の `SEMVER_SPOTS` / `MSIX_SPOTS` と `read_spot` / `write_spot` に足す。
**アンカーは、そのファイル内の他の版数めいた文字列に当たらない程度に狭くする** —
マニフェストの `MinVersion` とワークフローの engine ref は、緩い正規表現ひとつで
巻き添えになる位置にある。

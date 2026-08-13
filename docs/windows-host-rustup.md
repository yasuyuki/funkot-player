# Windows ホスト rustup が `./scripts/win-run.sh` で使えない

WSL から `./scripts/win-run.sh` で native exe を焼くと、Windows 側 rustup が
「既定ツールチェーンが無い」と落ちる。Linux の `./dev.sh` ビルドとは別問題。
直す作業はここから再開する。

## 症状

```text
./scripts/win-run.sh
```

`scripts/win-build.ps1` の `npm run tauri -- build --no-bundle` が即死する。

```text
failed to run 'cargo metadata' command to get workspace directory:
failed to run command cargo metadata:
error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.
help: run 'rustup default stable' to download the latest stable release of Rust and set it as your default toolchain.
```

観測: 2026-08-13、`develop`（0.1.6）を焼こうとしたとき。配備済み
`C:\funkot-player-test\funkot-player.exe` は 2026-08-11 の 0.1.5 のまま。

## 再現

作業ディレクトリは `funkot-player`（このリポジトリ）。Windows 側ミラーは
`C:\src\funkot-player`。PowerShell は WSL から起動する。

```sh
./scripts/win-run.sh -ForceBuild
```

`-ForceBuild` 無しでも `.win-run.stamp` が無い／ソースが変わっていれば同じ経路に入る。

## 原因（確認済み）

**Windows に Rust が無いのではない。** `rustup` は入っており、本物のホームには
`stable-x86_64-pc-windows-msvc` がある。WSL 起点のプロセスだけ、別の
`USERPROFILE` を見て空の rustup ホームを使う。

| | 値 |
|---|---|
| 本物の Windows プロファイル | `C:\Users\flame`（`[Environment]::GetFolderPath('UserProfile')` / `HOMEPATH=\Users\flame`） |
| WSL から起動したプロセスの `USERPROFILE` | `C:\Users\flame\work\foundation-candidate\home` |
| rustup が見るホーム | `%USERPROFILE%\.rustup` → 上の隔離ホーム |
| 本物の rustup | `C:\Users\flame\.rustup`（`settings.toml` に `default_toolchain = "stable-x86_64-pc-windows-msvc"`） |
| `APPDATA` | `C:\Users\flame\AppData\Roaming`（隔離されていない。`win-profile-guard` が触るプロファイルはこちら） |

PowerShell から見た差分（WSL 経由、`-NoProfile`）:

```text
USERPROFILE = C:\Users\flame\work\foundation-candidate\home
HOMEPATH    = \Users\flame
APPDATA     = C:\Users\flame\AppData\Roaming
GetFolderPath('UserProfile') = C:\Users\flame
```

`rustup.exe --version` を WSL から直接叩くと:

```text
rustup home:  C:\Users\flame\work\foundation-candidate\home\.rustup
no active toolchain
no installed toolchains
error: no default toolchain is configured
```

隔離ホーム側の `settings.toml` は **default_toolchain が無い**（中身は
`version = "12"` と `[overrides]` だけ）。2026-08-13 13:36 に、この調査で
`rustup.exe` を動かしたときに新規作成された。ツールチェーンは入っていない。

`scripts/win-build.ps1` は `$env:USERPROFILE\.cargo\bin` を PATH 先頭に足すだけ
で、`RUSTUP_HOME` / `CARGO_HOME` は触らない。WSL 起点ではそのパスが隔離ホーム
になり、PATH 上の本物 `C:\Users\flame\.cargo\bin\rustup.exe` が動いてもホームは
隔離側を見る。

この distro は foundation candidate（`FOUNDATION-RELEASE.json` の
`channel: candidate`）。隔離 `USERPROFILE` はその環境の副作用。WSL の
`HOME` / `RUSTUP_HOME` / `CARGO_HOME` は空で、リーク元は Windows 側の
`USERPROFILE` 上書き。

## やってはいけないこと

- **隔離ホームで `rustup default stable` しない。** 本物の
  `C:\Users\flame\.rustup` とは別に toolchain をダウンロードする。容量も時間も
  無駄で、根本（見ているホームが違う）は残る。
- **ホスト WSL の `rustup default` では直らない。** 落ちているのは Windows の
  `rustup.exe`。Linux 側に rustup は無い。
- **`./dev.sh` の Docker ビルドに寄せない。** Windows native exe は MSVC +
  `win-build.ps1` が正。Docker では `funkot-player.exe` は出ない。
- 隔離ホームの空 `.rustup` を「壊れたインストール」とみなして消すのは、直す
  作業の一部にしてよい。本物の `C:\Users\flame\.rustup` は消さない。

## 直す場所と方針

変更の中心は `scripts/win-build.ps1`（WSL ラッパ `scripts/win-run.sh` は
PowerShell を起動するだけ）。

1. 本物の Windows プロファイルを `USERPROFILE` ではなく
   `[Environment]::GetFolderPath('UserProfile')`（だめなら
   `Join-Path $env:HOMEDRIVE $env:HOMEPATH`）で取る。
2. その下の `.rustup` / `.cargo` を `RUSTUP_HOME` / `CARGO_HOME` に明示する。
3. PATH 先頭に足すのは `$env:CARGO_HOME\bin`（`$env:USERPROFILE\.cargo\bin` ではない）。
4. 既存の vcvars / `LIBCLANG_PATH` / sibling `funkot-core` チェックはそのまま。
5. README の Windows host smoke に、失敗したらこの文書を見る、を1行足してよい。
   手順の本文は増やさない。

`USERPROFILE` 自体を書き換えない方が安全。AppData 隔離や他ツールの想定を
壊さない。rustup が読むのは `RUSTUP_HOME` / `CARGO_HOME` で足りる。

## 受け入れ条件

- WSL の `funkot-player` ルートで `./scripts/win-run.sh -ForceBuild` が
  rustup の default-toolchain エラーで落ちない。
- 成果物が `C:\src\funkot-player\src-tauri\target\release\funkot-player.exe` に
  出る。`package.json` の版数（いま `develop` は 0.1.6）と一致する。
- `C:\funkot-player-test\funkot-player.exe` に deploy される。
- 本物の `C:\Users\flame\.rustup` に toolchain を追加ダウンロードしない
  （隔離ホームへの `rustup default` をしていない）。
- Linux `./dev.sh cargo test --manifest-path src-tauri/Cargo.toml --lib` は
  この修正の対象外（触らない）。

## 検証

```sh
# 1. まだ直す前なら、失敗メッセージが上の「症状」と一致することを確認してよい
./scripts/win-run.sh -ForceBuild

# 2. 直したあと
./scripts/win-run.sh -ForceBuild
# → "OK: built ...funkot-player.exe" と "OK: deployed to C:\funkot-player-test\funkot-player.exe"

# 3. どの rustup ホームを見ているか（直した ps1 と同じ環境で）
# 期待: rustup home が C:\Users\flame\.rustup
# 期待しない: C:\Users\flame\work\foundation-candidate\home\.rustup
```

起動確認はビルドが通ってから。空プロファイル相当で見るなら:

```sh
./scripts/win-profile-guard.sh -Run -ReplaceBackup
```

（ウィンドウを閉じると `%APPDATA%\jp.hatsuboshi.funkotplayer` が戻る。
`APPDATA` は隔離されていない。）

## 関連パス

| 用途 | パス |
|---|---|
| 本物の rustup | `C:\Users\flame\.rustup` |
| 本物の cargo bin | `C:\Users\flame\.cargo\bin` |
| 隔離ホーム（WSL 起点の `USERPROFILE`） | `C:\Users\flame\work\foundation-candidate\home` |
| 空の偽物 rustup（13:36 作成、toolchain 無し） | 上記 `\ .rustup` |
| ビルドスクリプト | `scripts/win-build.ps1` |
| WSL 入口 | `scripts/win-run.sh` |
| Windows ソースミラー | `C:\src\funkot-player` |
| 配備先 | `C:\funkot-player-test\funkot-player.exe` |

MSVC: `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`  
LLVM: `C:\Program Files\LLVM`（`LIBCLANG_PATH` 用。前回の失敗より手前で通っている）

## 直したら

このファイルは手順書にしない。`win-build.ps1` の短いコメント（なぜ
`GetFolderPath` を使うか）と、必要なら README の1行に残し、**この文書は消す。**
HANDOFF の「次にやること」からも落とす。

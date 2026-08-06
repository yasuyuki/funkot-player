# MSIX packaging (Microsoft Store)

Unsigned MSIX for Partner Center upload. Not a substitute for the NSIS GitHub
Release installer.

**Human submission steps** (Partner Center, privacy URL, upload, device check):
[`docs/store-submission.md`](../../docs/store-submission.md).

## Prerequisites

- Windows machine with Node, Rust, and a working `npm run tauri -- build`
- [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/)
  (`makeappx.exe` under `Program Files (x86)\Windows Kits\10\bin\...\x64\`)
- Partner Center app reservation (Identity **Name** / **Publisher**)

## Logos

`pack-msix.ps1` copies these from `src-tauri/icons/` into the package `Assets\`:

- `StoreLogo.png`
- `Square44x44Logo.png`
- `Square71x71Logo.png`
- `Square150x150Logo.png`

They are already produced by `tauri icon`. If missing, regenerate icons from
`src-tauri/app-icon.png`.

## Build → pack → submit

1. Align `Package.appxmanifest` **Identity Name**, **Publisher**, and
   **PublisherDisplayName** with Partner Center (current Store values are in
   the manifest; see `docs/store-submission.md`).
2. From the repo root in PowerShell:

   ```powershell
   npm run tauri -- build --no-bundle
   .\packaging\msix\scripts\pack-msix.ps1 -SkipBuild
   ```

   Or let the script build the exe (no NSIS/MSI bundle) then pack:

   ```powershell
   .\packaging\msix\scripts\pack-msix.ps1
   ```

3. Upload the unsigned package:

   `packaging\msix\out\Funkot_0.1.1.0_x64.msix`

Partner Center signs Store submissions; you normally submit the **unsigned**
MSIX produced here.

## Executable name

Cargo package name is `funkot-player`. `tauri.conf.json` sets `productName` to
`Funkot` but does **not** set `mainBinaryName`, so the release binary is
`funkot-player.exe`. The manifest `Application`/`Executable` matches that.

## crt-static / WebView2

Windows release builds use `crt-static` (`src-tauri/.cargo/config.toml`), so
extra Visual C++ redistributable DLLs are generally unnecessary. WebView2 is
expected to be present on the system (Evergreen Runtime); it is not bundled in
this MSIX.

## Fastest local run (no install, no signing)

MSIX は zip。中の exe を直接起動すればよい（Store 提出・自己署名は不要）:

```powershell
# Explorer で開く例（WSL パス）
explorer.exe \\wsl.localhost\Ubuntu\home\yasuyuki\Projects\funkot-player\packaging\msix\out\run
# → funkot-player.exe をダブルクリック
```

またはリポジトリ内で一度解凍:

```sh
mkdir -p packaging/msix/out/run
unzip -o packaging/msix/out/Funkot_0.1.1.0_x64.msix -d packaging/msix/out/run
```

Smart App Control が未署名 exe を止める場合だけ、NSIS Release や自己署名 MSIX
（下節）に切り替える。

## Optional: local self-sign (sideload only)

**Store 提出用の `.msix` は未署名のまま。** ダブルクリックインストールが
「publisher certificate could not be verified」になるのは正常。

ローカル試験だけ、**コピーを自己署名**する。証明書の **Subject は
`Package.appxmanifest` の `Identity Publisher` と一字一句一致**させる
（現状: `CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64`）。`CN=Funkot` など別値だと
署名後に Publisher mismatch で落ちる。

Windows PowerShell（管理者で後半の Import を実行）:

```powershell
$msixSrc = "\\wsl.localhost\Ubuntu\home\yasuyuki\Projects\funkot-player\packaging\msix\out\Funkot_0.1.1.0_x64.msix"
# または Windows 側にコピーしたパス
$dir = Split-Path $msixSrc
$msix = Join-Path $dir "Funkot_0.1.1.0_x64.sideload.msix"
Copy-Item $msixSrc $msix -Force

$publisher = "CN=FDFC3ACA-C9AA-47DF-9627-BB76E4AE4D64"
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher `
  -KeyUsage DigitalSignature -FriendlyName "Funkot Sideload" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3","2.5.29.19={text}")

$cer = Join-Path $dir "Funkot-sideload.cer"
Export-Certificate -Cert $cert -FilePath $cer | Out-Null

# SignTool: Windows SDK のパスは環境に合わせて調整
$signtool = "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
if (-not (Test-Path $signtool)) {
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
& $signtool sign /fd SHA256 /a /sha1 $cert.Thumbprint $msix

# 管理者 PowerShell で証明書をマシンの Trusted People へ（User ストアでは App Installer が信用しない）
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople

# インストール
Add-AppxPackage -Path $msix
# または署名済み .sideload.msix をダブルクリック
```

Partner Center には **未署名の元ファイル**（`Funkot_0.1.1.0_x64.msix`）を上げる。
`.sideload.msix` は提出に使わない。

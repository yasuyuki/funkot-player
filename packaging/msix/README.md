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

## Optional: local self-sign (sideload only)

For machine-local testing only (not for Store upload):

```powershell
# Create a self-signed cert once (example)
New-SelfSignedCertificate -Type Custom -Subject "CN=Funkot" `
  -KeyUsage DigitalSignature -FriendlyName "Funkot Dev" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3","2.5.29.19={text}")

# Sign with signtool from Windows SDK (thumbprint from the cert above)
signtool sign /fd SHA256 /a /f <path-or-store> packaging\msix\out\Funkot_0.1.1.0_x64.msix
```

Install the cert as Trusted People / root on that machine before sideloading.
Store packages should remain **unsigned** when uploading to Partner Center.

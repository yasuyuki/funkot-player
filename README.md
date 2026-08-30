# funkot-player

Auto-DJ music player for Funkot. Point it at a folder of tracks and it plays
them back-to-back with DJ-style transitions — no beatmatching, no decks, no
crossfader.

Primary platforms today: **Android** (GitHub Releases) and **Windows**
(Microsoft Store / MSIX; see below). iOS and macOS are planned. Linux is not
actively supported but is not deliberately broken either.

## What it does

- Mixes every track in its Music folder on a loop with DJ transitions
- Keeps playing with the screen off; transport controls appear in the
  notification shade and on the lock screen
- Scans new tracks in the background and shows progress
- Lets you queue, reorder, and drop tracks; the queue survives a restart
- Lets you correct intro / outro bar counts; corrections stick across
  re-analysis
- Lets you share feedback (`library.json` / `flags.json` / `meta.json`) via
  the system share sheet

Verified on a Pixel 8 Pro, including an hour of uninterrupted playback with
the screen off.

## Get the app

Android builds live on this repo's
[GitHub Releases](https://github.com/yasuyuki/funkot-player/releases).
Windows is distributed via the **Microsoft Store** (MSIX; Microsoft re-signs
the package). Packaging notes: [packaging/msix/README.md](packaging/msix/README.md),
submission checklist: [docs/store-submission.md](docs/store-submission.md).

### Android

Download the latest `.apk`, open it on the phone, and allow installing from
that source when Android asks (Settings → Apps → Special app access → Install
unknown apps, or the prompt shown at install time).

What to listen for: transitions that feel early/late or wrong, and anything
you fix on the edit screen. Use **⋮ → 意見を送る** to share a small ZIP back
(LINE, email, Drive, etc.).

Transport controls in the notification shade and on the lock screen are
**Android only**.

### Windows

Install **Funkot** from the Microsoft Store (when published). Unsigned NSIS
installers on GitHub Releases are **not** the recommended path — Smart App
Control / SmartScreen often blocks them.

On first desktop launch the app does **not** invent a Music library root or
seed demo tracks. Choose **Musicフォルダを選ぶ** (empty-state button or ⋮)
and point at a folder that already has audio — files are not copied or moved.
Until that choice is made, Start stays disabled. After a folder is set, use
**⋮ → Musicフォルダを開く** to inspect it in Explorer, and **⋮ → Musicフォルダを変更**
to pick another root. Then press **開始** (needs ≥2 tracks) or **⋮ → 再スキャン**.

**Musicフォルダを選ぶ / 変更** works on Windows/Mac/Linux only (not Android).
Changing the folder does not move files. Analysis and manual corrections are
keyed by content hash, so the same files carry over. Automatic selection
switches after a restart.

Linux: folder picking needs xdg-desktop-portal and a matching backend
(xdg-desktop-portal-gtk, etc.). Flatpak/snap usually provide this. Without
it the dialog may not open and the app only shows that nothing changed
(zenity may be used as a fallback).

**⋮ → 音楽フォルダを変更** で別のフォルダを指定できる（Windows/Mac/Linux のみ。
Android は不可）。変更してもファイルは移動されない。解析結果と手動補正は内容
ハッシュ管理なので同じファイルなら引き継がれる。自動選曲への反映は再起動後。

Linux: 音楽フォルダの選択には xdg-desktop-portal と対応バックエンド
（xdg-desktop-portal-gtk など）が要る。Flatpak/snap では自動的に揃う。無い環境
では選択ダイアログが開かず「変更しませんでした」とだけ表示される（zenity が
あればそれが代わりに使われる）。

Privacy policy (Store): [docs/privacy.md](docs/privacy.md) /
https://yasuyuki.github.io/funkot-player/privacy.html
Store publishing checklist: [docs/store-submission.md](docs/store-submission.md).

To send feedback, use **⋮ → 意見を送る** — on Windows this saves a ZIP and
shows its path (there is no system share sheet). Attach that file in email or
chat.

## Adding tracks (Android)

### Share them to the app (no cable)

Share the track files to **Funkot** from anywhere on the phone — a file
manager, Google Drive, LINE, or a Quick Share transfer that just arrived from
a PC. The app copies them into its Music folder and rescans on its own; there
is no folder to find and nothing to press afterwards.

This is how to get tracks across from a PC without a cable: send them to the
phone by whatever you already use (Quick Share for Windows, Drive, email),
then share them from the phone's Downloads into Funkot. Multi-select works.

The share sheet offers Funkot for anything the system calls `audio/*`, which
is wider than what the engine can decode — only `.wav` / `.mp3` / `.flac` /
`.m4a` / `.ogg` are taken, and the app says so when it drops the rest. Some
apps send audio as `application/octet-stream`; Funkot does not appear in the
share sheet for those.

### Or copy over USB

The app also plays whatever is dropped straight into its Music folder. On a
Pixel / stock Android device:

```
phone → Android → data → jp.hatsuboshi.funkotplayer → files → Music
```

(full path:
`/storage/emulated/0/Android/data/jp.hatsuboshi.funkotplayer/files/Music/`)

1. **Open the app once.** That creates the Music folder. Do not create it
   yourself from the PC — the app will not be able to read it. (**⋮ →
   Musicフォルダを開く** shows the path as a toast if you need to confirm it.)
2. **Connect the phone over USB** and choose file transfer (MTP), not
   charging-only.
3. **Open the Music folder** above in the PC's file manager.
4. **Copy track files into that folder.** Flat layout is fine; subfolders
   are not required.
5. **In the app**, press **開始** the first time, or **⋮ → 再スキャン** after
   adding more tracks.

Some devices hide `Android/data` from MTP entirely; on those, sharing is the
only route. Only the music shows up over MTP either way — queue, analysis
cache, and your bar-count corrections stay on the phone.

Bulk / resume-safe push from WSL over wireless adb (hundreds of tracks): see
[docs/adb-music-transfer.md](docs/adb-music-transfer.md).

## Using the app

- **開始 / 一時停止 / 次の曲** — main transport. Playback continues in the
  background. On Android, use the notification or lock-screen controls when
  the app is not on screen (Windows has in-app transport only).
- **Queue** — reorder with ↑↓, drop with ✕, and set the next track. Near a
  transition, some edits lock for a short window.
- **編集** — fix intro / outro bar counts on a transition that sounded wrong.
  Corrections are kept and re-applied after a fresh analysis.
- **⋮ → 再スキャン** — pick up tracks added since the last scan.
- **⋮ → Musicフォルダを選ぶ** — required on first desktop launch when no
  folder is configured yet (Windows/Mac/Linux only). Files are not moved.
- **⋮ → Musicフォルダを変更** — pick a different folder after one is set
  (desktop only). Analysis and manual corrections carry over by content hash.
- **⋮ → Musicフォルダを開く** — open the current Music folder (desktop).
  Hidden until a folder is chosen, and hidden on Android (`Android/data` is
  not reachable from a file manager).
- **⋮ → 意見を送る** — share a small ZIP of your corrections. Android opens
  the system share sheet; Windows saves the ZIP and shows its path.
- **⋮ → ログを表示** — diagnostic log for troubleshooting.

---

## For developers

Setup: [docs/development-setup.md](docs/development-setup.md)

Analysis and mixing come from
[funkot-autodj](https://github.com/yasuyuki/funkot-autodj)'s `funkot-core`.
This repo is the player around it.

### Layout

```
src-tauri/src/lib.rs   audio thread (cpal) + Tauri commands + JNI_OnLoad
src-tauri/build.rs     16 KB page-alignment link flag for Android
dist/index.html        the whole UI
Dockerfile             Rust + Android NDK/SDK + Node
dev.sh                 runs a command in that container
```

`funkot-core` is a **path dependency** on a sibling checkout of
[funkot-autodj](https://github.com/yasuyuki/funkot-autodj), expected at
`../funkot-autodj-for-ui`. The repos are separate to keep the sources from
mixing, not to make this one build standalone; `dev.sh` mounts the sibling
read-only at the matching path. Set `FUNKOT_CORE_REPO` if yours lives elsewhere.

The checkout is deliberately a *second* one, not the working checkout used for
engine development: a path dependency builds whatever happens to be checked out,
so a branch switch on the engine side would silently change this build. Anything
`funkot-player` needs from `funkot-core` — a branch, a fix, a pull — is done in
`funkot-autodj-for-ui`; the engine's own checkout is left alone.

### Build

Everything runs in the container, so the host needs only Docker.

```sh
./dev.sh npm install
./dev.sh npx tauri android init                       # once
./dev.sh npx tauri android build --debug --target aarch64
```

Release (signed; needs `src-tauri/gen/android/keystore.properties` +
`.secrets/upload-keystore.jks`, both gitignored):

```sh
./scripts/check-release-invariants.sh                 # see Invariant checks
./dev.sh npx tauri android build --target aarch64
# → src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

### Invariant checks

```sh
./scripts/check-release-invariants.sh
```

No Docker and no toolchain. CI runs it on every push
(`.github/workflows/checks.yml`); run it yourself before building a release
APK, because that build happens locally and never passes through CI.

It exists for one shape of bug: **release-only, silent, and invisible to debug
testing.** `isMinifyEnabled` is false for debug and true for release, so
anything R8 shrinks away keeps working in every on-device check made with a
debug APK, and no warning is printed at build time either. `Import.hasInFlight`
shipped that way — share-sheet import was dead in every release build for as
long as the feature existed, and nothing short of installing a release APK
would have shown it.

**When a bug turns out to have that shape, add a check to that script rather
than only fixing the bug.** A rule that lives in a code comment gets skipped by
the next person who adds a class; one that lives in the script cannot be. New
checks go in as a `check_*` function called from the list at the bottom of the
file. Keep the script toolchain-free: the moment it needs a build, it stops
running on every push.

### Shipping a GitHub Release

**Android (manual).** Build the signed APK locally, then attach it to a draft
Release for the tag before publishing:

1. Check out the `funkot-autodj-for-ui` commit you intend to ship (path dep does
   not pin it in `Cargo.lock`).
2. `./dev.sh npx tauri android build --target aarch64`
3. Upload `app-universal-release.apk` to the draft release for the tag.
   **Release notes (the GitHub Release body) are English**, even if the chat is
   Japanese. Partner Center listing copy stays Japanese.

**Windows (Microsoft Store / MSIX).** Preferred path. Human steps (Partner
Center, Pages, submit, device check):
[docs/store-submission.md](docs/store-submission.md). Packing details:
[packaging/msix/README.md](packaging/msix/README.md). CI:
[Windows MSIX](.github/workflows/windows-msix.yml) (`workflow_dispatch`) uploads
an **unsigned** `.msix` artifact for Partner Center.

**Windows NSIS (optional / not recommended for end users).** Tag push still
runs [Windows Release](.github/workflows/windows-release.yml) and can attach an
NSIS installer to a draft Release. Engine ref: `engine_ref` input,
`FUNKOT_ENGINE_REF`, or default `player/v0.1.1`. Unsigned NSIS is often blocked
by Smart App Control.

Review assets on the draft, then **Publish release** (Android). Submit MSIX via
Partner Center separately.

Install and run on a device over wireless debugging. Development uses two
phones, one per role: `debug` and `release` are signed with different keys, so
installing one over the other fails and forces a data-wiping `adb uninstall`.

Devices are addressed by role, never by address. Which phone fills which role
is a property of your machine, so it is configured there rather than in this
repository — see `adb-device`, which finds whatever IP and port wireless
debugging is using today and verifies the device's serial before handing it
back:

```sh
adb-device                                            # roles, and where they are
ADDR=$(adb-device debug)
ADB=1 ./dev.sh adb -s "$ADDR" logcat -s funkot
./scripts/install-apk.sh debug                        # finds the phone itself
./scripts/install-apk.sh release
```

`install-apk.sh` refuses to install unless the serial it finds matches the role
you asked for. Pass an address only to override the search
(`./scripts/install-apk.sh debug <ip>:<port>`, or `$FUNKOT_ADB_ADDR`).

Pairing is the one step that still needs the phone in your hand — the code and
the pairing port are only on its Wireless debugging screen, and the pairing
port is not the connect port:

```sh
ADB=1 ./dev.sh adb pair <ip>:<pair-port> <code>       # once per device
```

`ADB=1` starts the persistent adb server (`./scripts/adb-server.sh start`) if
needed. Stop it with `./scripts/adb-server.sh stop` (avoid `adb kill-server` —
it tears down that persistent server).

### Running the desktop build

Android is the platform this player is developed against; the desktop build
exists so a transition can be compared against what `funkot-autodj --render`
produces for the same playlist, which is far easier over speakers than over a
phone. On WSL, `GUI=1` hands the container WSLg's X11 and PulseAudio sockets:

```sh
./dev.sh cargo build --manifest-path src-tauri/Cargo.toml --release
cp <tracks> .desktop-data/Music/                      # created on first run
GUI=1 ./dev.sh ./src-tauri/target/release/funkot-player
```

- **Audio goes out through ALSA's pulse plugin**, not a sound card. cpal's Linux
  host is ALSA, the container has no device, and `/etc/asound.conf` in the image
  points `default` at PulseAudio. Two `snd_pcm_avail_delay` I/O errors at stream
  start are the plugin settling and do not repeat.
- **The window is Wayland by default** so WSLg can put a real Win32 window
  on the Windows taskbar. Container root + X11 is what produced a taskbar
  button with no window. For xdotool/import from a second container, add
  `GUI_X11=1` (`GDK_BACKEND=x11`); that path can ghost on Windows again:
  ```sh
  GUI=1 GUI_X11=1 ./dev.sh sh -c 'w=$(xdotool search --onlyvisible --name "^Funkot$" | tail -1);
      xdotool windowactivate --sync "$w";
      xdotool mousemove --sync --window "$w" 137 197 click 1'   # 「開始」@420x760
  ```
  Search by `productName` (`Funkot`) or `--class funkot-player` — not the
  binary name as `--name`. Use XTEST (`click` / `mousedown` without
  `--window`); `click --window ID` is XSendEvent and GTK/WebKit ignore it.
  Screen-absolute coordinates are the wrong tool: the window manager offsets
  the frame, so `mousemove --window` is what lands on the button.
- `⏸` and `⏭` come out as tofu in the container — it ships no font covering
  those code points. Not an app bug; a real desktop has the glyphs.
- This is the Linux path. **Windows installers are built in CI** (see Shipping a
  GitHub Release). **macOS builds are still untried.**

### Windows host smoke (WSL → native exe)

Build/deploy to `C:\funkot-player-test`, then run with an AppData guard so the
live profile is restored when the window closes:

```sh
./scripts/win-run.sh                         # build if needed, deploy
./scripts/win-profile-guard.sh -Run -ReplaceBackup
```

`-Run` backs up settings JSON + `Music\` + `funkot-cache\` to
`%APPDATA%\jp.hatsuboshi.funkotplayer.guard-bak`, **moves the live profile
aside** to `.guard-stash` and creates an empty first-launch directory
(`music_dir_needed`, pick a Music folder), launches the exe, and renames the
stash back on exit. If the script is killed before restore, the next
`-Backup` / `-Restore` / `-Run` puts the stash back first. Pass `-InPlace` to
skip the empty-profile step. Manual `-Backup` / `-Restore` are available;
`-SkipCache` omits the analysis cache from the round-trip.

### Working with a device

The adb key and the debug keystore both live in the `funkot-player-android-home`
Docker volume. Deleting it means re-pairing *and* a new signing key, which turns
the next `adb install -r` into `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

- **Finding the device.** Both its IP (DHCP) and its wireless-debugging port
  change, so `adb-device <role>` rediscovers them from the serial rather than
  anyone writing an address down. It tries the adb server's device list, then
  the address it remembered last time (cached under `~/.cache`), then mDNS —
  and verifies the serial before believing any of them.
  **mDNS is the slow path**: after a cold adb server one phone here showed up in
  about a second and the other took ~90 s, which is why the remembered address
  is tried first and why the mDNS wait is generous (`ADB_DEVICE_WAIT`).
  Discovery runs in the adb *server*, so it only works at all because that
  server now has its own long-lived container — a server that dies with each
  command never finishes discovering.
- **Persistent adb server.** Wireless clients share `funkot-player-adb`
  (`./scripts/adb-server.sh`), which holds port 5037 on the host network.
  Multiple `ADB=1 ./dev.sh` clients at once are fine once the server is up;
  connect once per session and later invocations keep the same device list.
  (Two cold starts racing to create the container are handled, but prefer a
  single `./scripts/adb-server.sh start` first.) Commands that occupy the
  device (e.g. `android dev`) can still conflict with each other. Prefer
  `./scripts/adb-server.sh stop` over `adb kill-server`. After rebuilding
  `funkot-player-dev`, recreate the server container so it picks up the new
  image: `./scripts/adb-server.sh stop && docker rm funkot-player-adb`.
- **Every reconnect pops a heads-up notification** ("Wireless debugging
  connected") over the top of the screen, and it eats taps aimed at the controls
  underneath — the tap opens Developer options instead, and the app looks
  unresponsive. Give it ~10 s to fade, or `adb shell cmd statusbar collapse`,
  before driving the UI.
- **Reading the UI is cheaper than screenshots.** `adb shell uiautomator dump`
  gives the WebView's text and bounds, so the table contents and button
  positions can be read directly rather than eyeballed. Re-dump before each tap:
  rows shift when the progress line appears or disappears.
- **Checking whether playback is paused: read the media session, not the audio
  stream.** `toggle_pause` only flips a flag; the callback keeps handing AAudio
  silence, so `dumpsys audio` reports the app's player as `state:started`
  either way. `dumpsys media_session` is the one that moves —
  `state=PLAYING(3)` vs `state=PAUSED(2)`.
- **UI automation only works while the screen is awake.** Once it times out the
  fingerprint lock takes over and adb cannot clear it (`wm dismiss-keyguard` and
  `KEYCODE_WAKEUP` both fail, `dumpsys trust` stays `deviceLocked=1`). For
  unattended runs set `adb shell svc power stayon true` first — it persists
  across reboots, so **put it back to `false` when done**.
- **`stayon` conflicts with any test that needs the screen off** (the B-4 soak).
  Order: start playback with `stayon` on, `input keyevent KEYCODE_HOME`,
  `svc power stayon false`, `input keyevent KEYCODE_SLEEP`, then confirm
  `dumpsys power` reports `mWakefulness=Asleep|Dozing`. Reversing the last two
  turns the screen back on.
- Clearing the analysis cache:
  `adb shell 'run-as jp.hatsuboshi.funkotplayer rm -rf files/funkot-cache'`.
  This drops only derived data. The queue and the hand-corrected bar counts sit
  beside the cache in `files/`, not inside it, precisely so that this command
  stays safe to hand out; see the comment at the top of `src-tauri/src/store.rs`.
- The three synthetic test tracks are in
  `funkot-autodj-for-ui/testdata/spike-synth/` (gitignored). Regenerate with
  `./dev.sh cargo run -p funkot-core --example gen_synth --features testutil
  --release -- testdata/spike-synth`.

### Android notes

These were all found the hard way on a real device. Each one is commented at the
place it matters, but they are easy to undo by accident:

- **minSdk is 26**, set in `src-tauri/tauri.conf.json`. `libaaudio.so`, which
  cpal's Android backend links, first appears in the NDK sysroot at API 26.
  Editing `gen/android/app/build.gradle.kts` instead does *not* work — the Tauri
  CLI picks the linker from its own config value.
- **`JNI_OnLoad` in `src/lib.rs` is load-bearing.** Tauri ships its own Kotlin
  Activity rather than using `android-activity`, so nothing initialises
  `ndk-context`; cpal calls `ndk_context::android_context()` while building a
  stream and that *panics* rather than returning an error. Deleting `JNI_OnLoad`
  makes playback die with "android context was not initialized".
- **The 16 KB alignment flag comes from `build.rs`**, not from
  `CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS`, because the Tauri CLI fills
  that variable and cargo lets an env var replace config rustflags instead of
  merging. Without it Android 15+ shows a compatibility dialog at launch.
- **The UI must respect safe-area insets.** Tauri draws edge-to-edge; a control
  at the top of the page ends up under the status bar and the system swallows
  the touch, so the app looks unresponsive rather than misdrawn.
- **Never hard-code the music path**, even though it is predictable. A directory
  created under `/storage/emulated/0/Android/data/<pkg>/files` from outside the
  app — over adb or MTP — is owned by `shell:ext_data_rw` and the app cannot even
  list it. `getExternalFilesDir` creates it with the right ownership, which is
  why `app_dirs` goes through JNI instead of formatting a string. Copying files
  *into* an app-created directory from a PC is fine.
- **`PlaybackService` is what keeps the sound on.** Without a
  `mediaPlayback`-typed foreground service the stream stays alive when
  backgrounded but the system mutes it, which `dumpsys audio` reports as
  `mutedState:opControlAudio` while still saying `state:started`. The service
  plays nothing itself; it exists to make the process foreground-privileged.
- **The MediaSession is not decoration either.** A plain ongoing notification,
  even with actions, lands in the silent section of the shade and gets collapsed
  into the icon strip at the bottom, where nobody will find it — the controls
  looked simply absent. Backing the notification with a `MediaSession` and
  `Notification.MediaStyle` is what moves it to the media area and the lock
  screen. Both use framework APIs, so neither costs a dependency.
- **Never resolve an app class with `find_class` off the UI thread.** Commands
  marked `#[tauri::command(async)]` run on Tauri's blocking thread pool, and a
  thread JNI attaches on the fly gets the *system* classloader, which cannot see
  `jp.hatsuboshi.funkotplayer.*`. `service_call` goes through
  `Context.getClassLoader()` for this reason — and it has to be that instance
  method, not the loader of the context object's class, which is
  `android.app.Application`'s and therefore the boot loader. Getting this wrong
  costs the notification, the foreground service and the MediaSession, while
  leaving playback itself working, so it is easy to miss.
- **A class Rust reaches over JNI needs a `-keep` rule in
  `gen/android/app/proguard-rules.pro`,** with `{ *; }` rather than a narrower
  member list. `load_class` and `call_static_method` take strings, so R8 sees no
  reference and shrinks or renames the class away in release, where
  `isMinifyEnabled` is true — while debug, where it is false, goes on working.
  A missing rule for `Import` is what left share-sheet import dead in every
  release build. `./scripts/check-release-invariants.sh` diffs the two lists;
  see [Invariant checks](#invariant-checks).
- The Tauri CLI must be a **project-local** npm install. A global one makes the
  generated Gradle task run `node tauri` and fail to resolve it.
- **Share-sheet import keeps no in-process queue.** `Import.kt` stages a file
  as `<name>.part` and renames it once the copy finishes; the staging
  directory's own contents are what `take_pending_import` walks. An in-memory
  list of "what was staged" looks simpler and is wrong twice over: it drops a
  file that finishes copying between a status check and the read, and it
  strands one permanently if the process dies before the read — the list does
  not survive a restart, but the file on disk does.
- **`Import.hasInFlight()` must be read *before* that walk, never after.**
  Read after, a copy that lands between the walk and the read reports
  `in_flight: false`, so the frontend never looks again — and post-cold-start
  the `visibilitychange` path does not fire either, so the share is lost.
- **`MainActivity.onCreate` guards on `savedInstanceState == null`.** A
  configuration change this Activity does not declare in `android:configChanges`
  (a system font-size change is enough) re-runs `onCreate` with the same
  `ACTION_SEND` intent, and without the guard the file is imported twice.
- **A hand-fired `ACTION_SEND` needs the URI in `-d` as well as in the extra.**
  `ActivityManager` only grants read access to URIs it finds in the intent's
  data and `ClipData`; one that exists solely in `EXTRA_STREAM` gets no grant,
  and `openInputStream` then fails with `SecurityException` — the app opens and
  silently imports nothing. Real senders avoid this because `startActivity`
  runs `Intent.migrateExtraStreamToClipData()` in the *sending* process. So a
  test intent has to name the URI twice:

  ```
  adb shell am start -a android.intent.action.SEND -t audio/mpeg \
    -n jp.hatsuboshi.funkotplayer/.MainActivity --grant-read-uri-permission \
    -d content://media/external/audio/media/<id> \
    --eu android.intent.extra.STREAM content://media/external/audio/media/<id>
  ```

  `am` has no option that builds an `ArrayList<Uri>`, so `ACTION_SEND_MULTIPLE`
  cannot be fired this way at all — it has to come from a real share sheet.

## Licence

MIT.

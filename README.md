# funkot-player

Auto-DJ music player for Funkot. Point it at a folder of tracks, build a queue,
and it plays them back-to-back with DJ-style transitions — no beatmatching, no
decks, no crossfader. All the analysis and mixing comes from
[funkot-autodj](https://github.com/yasuyuki/funkot-autodj)'s `funkot-core`;
this repo is the player around it.

Target platforms, in priority order: **Android**, iOS, Windows, macOS. Linux is
not actively supported but is not deliberately broken either.

## Status

Usable as a folder player. On Android, drop tracks into the app's Music folder
over MTP, press start, and it mixes the whole folder on a loop with DJ
transitions — including with the screen off, with transport controls in the
notification shade and on the lock screen. Scanning the library analyses any
new tracks in the background, showing progress as it goes. Tracks can be
queued, reordered and dropped, and the queue survives a restart. Tapping an
intro or outro bar count corrects it, and the correction is re-applied after
every fresh analysis. Verified on a Pixel 8 Pro, including an hour of
uninterrupted playback backgrounded with the screen off.

## Layout

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

## Build

Everything runs in the container, so the host needs only Docker.

```sh
./dev.sh npm install
./dev.sh npx tauri android init                       # once
./dev.sh npx tauri android build --debug --target aarch64
```

Install and run on a device over wireless debugging:

```sh
ADB=1 ./dev.sh adb pair <ip>:<pair-port> <code>       # once per device
ADB=1 ./dev.sh adb connect <ip>:<connect-port>
ADB=1 ./dev.sh adb install -r \
    src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
ADB=1 ./dev.sh adb logcat -s funkot
```

The connect port differs from the pairing port; both are on the device's
Wireless debugging screen.

## Running the desktop build

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
- **The window is X11 on purpose** (`GDK_BACKEND=x11` in `dev.sh`). Under
  Wayland the window cannot be driven or captured from a second container;
  on X11 `xdotool` and `import` both work, and both are in the image:
  ```sh
  ./dev.sh sh -c 'w=$(xdotool search --name "^funkot-player$" | tail -1);
      xdotool mousemove --window $w 210 40 click 1'   # window-relative
  ```
  Screen-absolute coordinates are the wrong tool: the window manager offsets
  the frame, so `mousemove --window` is what lands on the button.
- `⏸` and `⏭` come out as tofu in the container — it ships no font covering
  those code points. Not an app bug; a real desktop has the glyphs.
- This is the Linux path. **Windows and macOS builds are still untried.**

## Working with a device

The adb key and the debug keystore both live in the `funkot-player-android-home`
Docker volume. Deleting it means re-pairing *and* a new signing key, which turns
the next `adb install -r` into `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

- **Finding the device.** Both its IP (DHCP) and its wireless-debugging port
  change. mDNS does not cross the container boundary, so scan for it:
  `nmap -sn 192.168.10.0/24`, then `nmap -Pn -p 1024-65535 --open -T4 <ip>`.
  Several ports answer; only one of them is adb, the rest go `offline` on
  `adb connect`. Do not narrow the range — ports above 50000 are common.
- **Never run two `ADB=1 ./dev.sh` at once.** `--network host` means every
  container shares the host's port 5037, and the adb servers fight. The symptom
  is `protocol fault (couldn't read status length)`, which looks like a device
  fault but is self-inflicted. Note also that each container gets a *fresh* adb
  server, so every invocation must `adb connect` again.
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

## Android notes

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
- The Tauri CLI must be a **project-local** npm install. A global one makes the
  generated Gradle task run `node tauri` and fail to resolve it.

## Licence

MIT.

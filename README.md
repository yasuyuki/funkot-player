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
notification shade and on the lock screen. Verified on a Pixel 10 Pro
(Android 17).

Not yet built: library scanning, the queue, and intro/outro bar editing.

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

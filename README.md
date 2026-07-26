# funkot-player

Auto-DJ music player for Funkot. Point it at a folder of tracks, build a queue,
and it plays them back-to-back with DJ-style transitions — no beatmatching, no
decks, no crossfader. All the analysis and mixing comes from
[funkot-autodj](https://github.com/yasuyuki/funkot-autodj)'s `funkot-core`;
this repo is the player around it.

Target platforms, in priority order: **Android**, iOS, Windows, macOS. Linux is
not actively supported but is not deliberately broken either.

## Status

Early. This is the verified Android spike promoted to a repo: the toolchain, the
audio path and the platform workarounds are proven on a real device (Pixel 10
Pro / Android 17), but the UI is still a single "start" button that plays every
file in one hard-coded directory.

Not yet built: library scanning, the queue, intro/outro bar editing, and
background playback. See the plan for what those are.

## Layout

```
src-tauri/src/lib.rs   audio thread (cpal) + Tauri commands + JNI_OnLoad
src-tauri/build.rs     16 KB page-alignment link flag for Android
dist/index.html        the whole UI
Dockerfile             Rust + Android NDK/SDK + Node
dev.sh                 runs a command in that container
```

`funkot-core` is a **path dependency** on a sibling `funkot-autodj` checkout.
The repos are separate to keep the sources from mixing, not to make this one
build standalone; `dev.sh` mounts the sibling read-only at the matching path.
Set `FUNKOT_CORE_REPO` if yours lives elsewhere.

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
- **Background playback needs a foreground service**, which does not exist yet.
  Right now the stream stays alive when backgrounded but the system mutes it
  (`mutedState:opControlAudio`), so audio only comes out while the app is on
  screen.
- The Tauri CLI must be a **project-local** npm install. A global one makes the
  generated Gradle task run `node tauri` and fail to resolve it.

## Licence

MIT.

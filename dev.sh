#!/bin/sh
# Run a command inside the build container.
#
# This repo is mounted at /work/funkot-player and the sibling
# funkot-autodj-for-ui checkout read-only at /work/funkot-autodj-for-ui, which
# is what the `funkot-core` path dependency in src-tauri/Cargo.toml resolves to.
#
# funkot-autodj-for-ui is a second checkout of the funkot-autodj repo, kept for
# this player so that engine work in the original checkout cannot change this
# build by switching branches. Point FUNKOT_CORE_REPO elsewhere to override.
#
# Usage:
#   ./dev.sh npx tauri android build --debug --target aarch64
#   ./dev.sh cargo test --manifest-path src-tauri/Cargo.toml
#
# ADB=1 additionally shares the host network, for talking to a device over
# wireless debugging:
#   ADB=1 ./dev.sh adb devices -l
#
# Hot reload on the device needs BOTH --host 127.0.0.1 and adb reverse. Without
# --host the Tauri CLI rewrites devUrl to WSL2's NAT address, which the phone
# cannot reach, and the window comes up blank; setting TAURI_DEV_HOST first does
# not help because the CLI overwrites it. 1421 is the HMR socket:
#   ADB=1 ./dev.sh bash -c '
#     adb connect <ip>:<port>
#     adb reverse tcp:1420 tcp:1420; adb reverse tcp:1421 tcp:1421
#     npx tauri android dev --host 127.0.0.1'
# Note that `android dev` holds the device for as long as it runs, so nothing
# else can use adb meanwhile -- to drive the UI yourself, install a debug APK
# instead.
#
# GUI=1 runs the desktop build on WSLg's display and sound card. --features
# custom-protocol is what bakes dist/ into the binary; without it the build is a
# dev build and the window only says it cannot reach the Vite server (see the
# comment on that feature in src-tauri/Cargo.toml). Run `npm run build` first --
# cargo does not rebuild when only dist/ changed:
#   ./dev.sh npm run build
#   ./dev.sh cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol
#   GUI=1 ./dev.sh ./src-tauri/target/release/funkot-player
#
# /root/.android is a named volume on every run, not just for adb: the debug
# keystore lives there, and letting it be regenerated per build changes the APK
# signature and makes `adb install -r` fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE.
set -eu
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker Engine is required but \`docker\` was not found on PATH." >&2
    echo "Install Docker Engine and ensure \`docker\` works for your user." >&2
    echo "See docs/development-setup.md" >&2
    exit 127
fi

IMAGE=funkot-player-dev
CORE_DIR=${FUNKOT_CORE_REPO:-"$PWD/../funkot-autodj-for-ui"}

if [ ! -d "$CORE_DIR/funkot-core" ]; then
    echo "cannot find funkot-autodj-for-ui at $CORE_DIR" >&2
    echo "clone funkot-autodj there next to this repo, or set FUNKOT_CORE_REPO" >&2
    exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -t "$IMAGE" .
fi

# The container runs as root; hand back ownership of anything it wrote here.
# gen/ and node_modules/ are written by the Tauri CLI on every build.
CHOWN="chown -R \"\$HOST_UID:\$HOST_GID\" /work/funkot-player 2>/dev/null || true"

[ "${ADB:-0}" = 1 ] && NET="--network host" || NET=""

# GUI=1 runs the desktop build with a screen and a sound card: the X11 socket
# and WSLg's PulseAudio socket are passed in, and cpal's ALSA host reaches the
# latter through the pulse plugin (see /etc/asound.conf in the Dockerfile).
#
# GDK_BACKEND=x11 is not cosmetic. Left to itself GDK connects to the wayland-0
# socket in XDG_RUNTIME_DIR, and a Wayland window cannot be driven or captured
# from a second container -- xdotool and import both work on X11 only.
#
# The app's data lives on the host so the analysis cache and the queue survive a
# restart; drop the tracks to play into .desktop-data/Music.
GUI_ARGS=""
if [ "${GUI:-0}" = 1 ]; then
    [ -S /mnt/wslg/PulseServer ] || {
        echo "GUI=1 expects WSLg's PulseServer socket at /mnt/wslg/PulseServer" >&2
        exit 1
    }
    mkdir -p "$PWD/.desktop-data/Music"
    GUI_ARGS="--shm-size=1g
        -v /tmp/.X11-unix:/tmp/.X11-unix
        -v /mnt/wslg:/mnt/wslg
        -v $PWD/.desktop-data:/root/.local/share/jp.hatsuboshi.funkotplayer
        -e DISPLAY=${DISPLAY:-:0}
        -e GDK_BACKEND=x11
        -e XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
        -e PULSE_SERVER=unix:/mnt/wslg/PulseServer
        -e WEBKIT_DISABLE_COMPOSITING_MODE=1
        -e WEBKIT_DISABLE_DMABUF_RENDERER=1
        -e RUST_LOG=${RUST_LOG:-info}"
fi

# shellcheck disable=SC2086
exec docker run --rm -i $NET $GUI_ARGS \
    -v "$PWD":/work/funkot-player \
    -v "$(cd "$CORE_DIR" && pwd)":/work/funkot-autodj-for-ui:ro \
    -v funkot-player-cargo-registry:/usr/local/cargo/registry \
    -v funkot-player-gradle:/root/.gradle \
    -v funkot-player-android-home:/root/.android \
    -e CARGO_TERM_COLOR=never \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    "$IMAGE" sh -c '"$@"; status=$?; '"$CHOWN"'; exit $status' -- "$@"

#!/bin/sh
# Run a command inside the build container.
#
# This repo and the sibling funkot-autodj-for-ui checkout are mounted under
# /work/by-core… so each host worktree gets a distinct container path (PackageId)
# while ../../funkot-autodj-for-ui from src-tauri still resolves to the core mount.
#
# funkot-autodj-for-ui is a second checkout of the funkot-autodj repo. Official
# builds require its clean HEAD to equal funkot-core.commit; point
# FUNKOT_CORE_REPO at a clean sibling with that SHA, or use the explicit
# FUNKOT_CORE_CANDIDATE_SHA route for an unmerged candidate.
#
# Usage:
#   ./dev.sh npx tauri android build --debug --target aarch64
#   ./dev.sh cargo test --manifest-path src-tauri/Cargo.toml
#
# ADB=1 additionally shares the host network, for talking to a device over
# wireless debugging. It first ensures the persistent adb server container
# (`funkot-player-adb`, via ./scripts/adb-server.sh start) is running, then
# runs as a client against that server on port 5037:
#   ADB=1 ./dev.sh adb devices -l
#
# Connect once per session; later ADB=1 ./dev.sh adb ... calls reuse the same
# device list. Multiple ADB=1 clients at once are fine (they share one server).
# Commands that occupy the device (e.g. `android dev`) can still conflict with
# each other. Do not `adb kill-server` casually — that stops the persistent
# server; use ./scripts/adb-server.sh stop instead. Pairing keys live in the
# funkot-player-android-home volume as before.
#
# Hot reload on the device needs BOTH --host 127.0.0.1 and adb reverse. Without
# --host the Tauri CLI rewrites devUrl to WSL2's NAT address, which the phone
# cannot reach, and the window comes up blank; setting TAURI_DEV_HOST first does
# not help because the CLI overwrites it. 1421 is the HMR socket. If already
# connected this session, the connect line can be omitted:
#   ADB=1 ./dev.sh bash -c '
#     adb connect <ip>:<port>   # skip if already connected
#     adb reverse tcp:1420 tcp:1420; adb reverse tcp:1421 tcp:1421
#     npx tauri android dev --host 127.0.0.1'
# Note that `android dev` holds the device for as long as it runs, so nothing
# else can use that device meanwhile -- to drive the UI yourself, install a
# debug APK instead.
#
# GUI=1 runs the desktop build on WSLg's display and sound card. --features
# custom-protocol is what bakes dist/ into the binary; without it the build is a
# dev build and the window only says it cannot reach the Vite server (see the
# comment on that feature in src-tauri/Cargo.toml). Run `npm run build` first --
# cargo does not rebuild when only dist/ changed:
#   ./dev.sh npm run build
#   ./dev.sh cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol
#   GUI=1 ./dev.sh /cargo-target/release/funkot-player
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

FUNKOT_CORE_REPO="$CORE_DIR" ./scripts/check-funkot-core-commit.sh
CANDIDATE_ENV=""
if [ -n "${FUNKOT_CORE_CANDIDATE_SHA:-}" ]; then
    # The preflight accepts only a 40-character lowercase SHA, so this
    # deliberate argv expansion cannot split or reinterpret user input.
    CANDIDATE_ENV="-e FUNKOT_CORE_CANDIDATE_SHA=$FUNKOT_CORE_CANDIDATE_SHA"
fi
CORE_GIT_COMMON=$(git -C "$CORE_DIR" rev-parse --git-common-dir)
case "$CORE_GIT_COMMON" in
    /*) ;;
    *) CORE_GIT_COMMON=$(CDPATH= cd "$CORE_DIR/$CORE_GIT_COMMON" && pwd) ;;
esac
[ -d "$CORE_GIT_COMMON" ] || {
    echo "cannot resolve core git metadata at $CORE_GIT_COMMON" >&2
    exit 1
}

# INVARIANT: STORE_MOUNT is fixed. Cargo bakes absolute OUT_DIR paths into
# replayed build-script outputs; changing it invalidates the store.
STORE_MOUNT=/cargo-target
FUNKOT_CARGO_TARGET=${FUNKOT_CARGO_TARGET:-funkot-player-cargo-target}

# Host realpaths -> one path segment each (no hash). Core path is keyed by the
# core checkout, so two player worktrees that share a core share CORE_MOUNT.
core_host=$(CDPATH= cd "$CORE_DIR" && pwd -P)
player_host=$(pwd -P)
core_seg=$(printf '%s' "$core_host" | tr '/' '_')
player_seg=$(printf '%s' "$player_host" | tr '/' '_')
bind_parent=/work/by-core${core_seg}
PLAYER_MOUNT=${bind_parent}/${player_seg}
CORE_MOUNT=${bind_parent}/funkot-autodj-for-ui

# Leftover worktree target dirs are not the Cargo output under this design.
if [ -d "$PWD/src-tauri/target" ] && [ ! -L "$PWD/src-tauri/target" ]; then
    echo "note: $PWD/src-tauri/target is not the Cargo output; container store is $STORE_MOUNT" >&2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -t "$IMAGE" .
fi

# The container runs as root; hand back ownership of anything it wrote here.
# gen/ and node_modules/ are written by the Tauri CLI on every build.
#
# Only do this under rootful Docker. Under rootless Docker, container UID 0
# already *is* the invoking host user, and any other container UID (such as
# $HOST_UID) is remapped through /etc/subuid to a disjoint high host UID
# range -- chown-ing to "$HOST_UID:$HOST_GID" there does not restore the
# invoking user's ownership, it reassigns everything to that subuid-mapped
# id and locks the invoking user out instead.
if docker info --format '{{range .SecurityOptions}}{{.}}{{"\n"}}{{end}}' 2>/dev/null \
    | grep -qx 'name=rootless'; then
    CHOWN=':'
else
    CHOWN="chown -R --one-file-system \"\$HOST_UID:\$HOST_GID\" '$PLAYER_MOUNT' 2>/dev/null || true"
fi

if [ "${ADB:-0}" = 1 ]; then
    ./scripts/adb-server.sh start
    NET="--network host"
else
    NET=""
fi

# GUI=1 runs the desktop build with a screen and a sound card: the Wayland
# and PulseAudio sockets from WSLg are passed in, and cpal's ALSA host
# reaches Pulse through the pulse plugin (see /etc/asound.conf in the Dockerfile).
#
# The container must run as the WSLg session user (the wayland-0 owner) with
# host PID/IPC. Root in a PID namespace is what produced a Windows taskbar
# button and no window (weston ClientGetAppidReq pid:0). Default backend is
# Wayland so RAIL binds a real Win32 window. GUI_X11=1 restores GDK_BACKEND=x11
# for xdotool/import from a second container; that path can ghost again.
#
# The app's data lives on the host so the analysis cache and the queue survive a
# restart; drop the tracks to play into .desktop-data/Music.
GUI_ARGS=""
if [ "${GUI:-0}" = 1 ]; then
    [ -S /mnt/wslg/PulseServer ] || {
        echo "GUI=1 expects WSLg's PulseServer socket at /mnt/wslg/PulseServer" >&2
        exit 1
    }
    [ -S /mnt/wslg/runtime-dir/wayland-0 ] || {
        echo "GUI=1 expects WSLg's Wayland socket at /mnt/wslg/runtime-dir/wayland-0" >&2
        exit 1
    }
    mkdir -p "$PWD/.desktop-data/Music"
    chmod -R a+rwX "$PWD/.desktop-data" 2>/dev/null || true
    WSLG_UID=$(stat -c %u /mnt/wslg/runtime-dir/wayland-0)
    WSLG_GID=$(stat -c %g /mnt/wslg/runtime-dir/wayland-0)
    GDK_BACKEND_ARGS=""
    if [ "${GUI_X11:-0}" = 1 ]; then
        GDK_BACKEND_ARGS="-e GDK_BACKEND=x11"
    fi
    # Trixie zenity is GTK4. GSK's default GL/Vulkan path draws only the
    # window chrome on WSLg; cairo is the software renderer. Do not put
    # comments inside GUI_ARGS — it is word-split into docker argv.
    GUI_ARGS="--pid=host --ipc=host --user ${WSLG_UID}:${WSLG_GID} --shm-size=1g
        -v /tmp/.X11-unix:/tmp/.X11-unix
        -v /mnt/wslg:/mnt/wslg
        -v $PWD/.desktop-data:/tmp/.local/share/jp.hatsuboshi.funkotplayer
        -e HOME=/tmp
        -e DISPLAY=${DISPLAY:-:0}
        -e WAYLAND_DISPLAY=wayland-0
        ${GDK_BACKEND_ARGS}
        -e XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
        -e PULSE_SERVER=unix:/mnt/wslg/PulseServer
        -e WEBKIT_DISABLE_COMPOSITING_MODE=1
        -e WEBKIT_DISABLE_DMABUF_RENDERER=1
        -e GSK_RENDERER=cairo
        -e RUST_LOG=${RUST_LOG:-info}"
fi

# shellcheck disable=SC2086
exec docker run --rm -i $NET $GUI_ARGS $CANDIDATE_ENV \
    -v "$PWD":"$PLAYER_MOUNT" \
    -v "$core_host":"$CORE_MOUNT":ro \
    -w "$PLAYER_MOUNT" \
    -v "$CORE_GIT_COMMON":"$CORE_GIT_COMMON":ro \
    -v funkot-player-cargo-registry:/usr/local/cargo/registry \
    -v funkot-player-gradle:/root/.gradle \
    -v funkot-player-android-home:/root/.android \
    -v "$FUNKOT_CARGO_TARGET":"$STORE_MOUNT" \
    -e CARGO_TARGET_DIR="$STORE_MOUNT" \
    -e CARGO_TERM_COLOR=never \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0="$CORE_MOUNT" \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    "$IMAGE" sh -c '"$@"; status=$?; '"$CHOWN"'; exit $status' -- "$@"

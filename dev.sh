#!/bin/sh
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
FUNKOT_CARGO_TARGET_EXPLICIT=0
[ -n "${FUNKOT_CARGO_TARGET+x}" ] && FUNKOT_CARGO_TARGET_EXPLICIT=1
FUNKOT_CARGO_TARGET=${FUNKOT_CARGO_TARGET:-funkot-player-cargo-target}
export FUNKOT_CARGO_TARGET_EXPLICIT

core_host=$(CDPATH= cd "$CORE_DIR" && pwd -P)
player_host=$(pwd -P)
core_seg=$(printf '%s' "$core_host" | sha256sum | cut -d ' ' -f 1)
player_seg=$(printf '%s' "$player_host" | sha256sum | cut -d ' ' -f 1)
bind_parent=/work/by-core${core_seg}
PLAYER_MOUNT=${bind_parent}/${player_seg}
CORE_MOUNT=${bind_parent}/funkot-autodj-for-ui

if [ -d "$PWD/src-tauri/target" ] && [ ! -L "$PWD/src-tauri/target" ]; then
    echo "note: $PWD/src-tauri/target is not the Cargo output; container store is $STORE_MOUNT" >&2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -t "$IMAGE" .
fi

MANAGED_OWNER=0
if [ -n "${WORKSPACE_LIFECYCLE_CONTEXT:-}" ]; then
    OWNER_INTERPRETER=$(python3 -c 'import json, os; print(json.loads(os.environ["WORKSPACE_LIFECYCLE_CONTEXT"])["owner_receipt_argv"][0])') || {
        echo "invalid WORKSPACE_LIFECYCLE_CONTEXT" >&2
        exit 2
    }
    case "$OWNER_INTERPRETER" in
        /*) ;;
        *) echo "managed lifecycle interpreter must be absolute" >&2; exit 2 ;;
    esac
    OWNER_LOCK_DIR=$("$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["WORKSPACE_LIFECYCLE_CONTEXT"])["owner_receipt_dir"])') || exit $?
    exec 9>"$OWNER_LOCK_DIR/.funkot-player-build.lock"
    flock -x 9
    export FUNKOT_PLAYER_OWNER_OUTER_LEASE=1
    OWNER_RECORD=$("$OWNER_INTERPRETER" "$PWD/scripts/lifecycle-product-owner.py" prepare) || exit $?
    OWNER_GENERATION=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["generation"])') || exit $?
    FUNKOT_CARGO_TARGET=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["cargo_target"])') || exit $?
    OWNER_NODE_VOLUME=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["node_volume"]["name"])') || exit $?
    OWNER_DIST=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["dist"])') || exit $?
    OWNER_TAURI_SCHEMAS=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["tauri_schemas"])') || exit $?
    OWNER_ANDROID_PROJECT_BUILD=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_project_build"])') || exit $?
    OWNER_ANDROID_BUILDSRC_BUILD=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_buildsrc_build"])') || exit $?
    OWNER_ANDROID_BUILDSRC_GRADLE=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_buildsrc_gradle"])') || exit $?
    OWNER_ANDROID_BUILD=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_build"])') || exit $?
    OWNER_ANDROID_GRADLE=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_gradle"])') || exit $?
    OWNER_ANDROID_GENERATED_JAVA=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_generated_java"])') || exit $?
    OWNER_ANDROID_GENERATED_ASSETS=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_generated_assets"])') || exit $?
    OWNER_ANDROID_PROGUARD_TAURI=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_proguard_tauri"])') || exit $?
    OWNER_ANDROID_TAURI_BUILD_GRADLE=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_tauri_build_gradle"])') || exit $?
    OWNER_ANDROID_TAURI_PROPERTIES=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_tauri_properties"])') || exit $?
    OWNER_ANDROID_TAURI_SETTINGS=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["mounts"]["android_tauri_settings"])') || exit $?
    OWNER_ANDROID_JNI_VOLUME=$(OWNER_RECORD="$OWNER_RECORD" "$OWNER_INTERPRETER" -c 'import json, os; print(json.loads(os.environ["OWNER_RECORD"])["jni_volume"]["name"])') || exit $?
    MANAGED_OWNER=1
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
if [ "$MANAGED_OWNER" != 1 ]; then
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
    "$IMAGE" sh -c 'core=$1; shift; python3 scripts/dev_source_guard.py --source-root "$PWD" --source-root "$PWD/src-tauri" --source-root "$core" -- "$@"; status=$?; '"$CHOWN"'; exit $status' -- "$CORE_MOUNT" "$@"
fi

set +e
# shellcheck disable=SC2086
docker run --rm -i $NET $GUI_ARGS $CANDIDATE_ENV \
    -v "$PWD":"$PLAYER_MOUNT" \
    -v "$core_host":"$CORE_MOUNT":ro \
    -w "$PLAYER_MOUNT" \
    -v "$CORE_GIT_COMMON":"$CORE_GIT_COMMON":ro \
    -v funkot-player-cargo-registry:/usr/local/cargo/registry \
    -v funkot-player-gradle:/root/.gradle \
    -v funkot-player-android-home:/root/.android \
    -v "$FUNKOT_CARGO_TARGET":"$STORE_MOUNT" \
    -v "$OWNER_NODE_VOLUME":"$PLAYER_MOUNT/node_modules" \
    -v "$OWNER_DIST":"$PLAYER_MOUNT/dist" \
    -v "$OWNER_TAURI_SCHEMAS":"$PLAYER_MOUNT/src-tauri/gen/schemas" \
    -v "$OWNER_ANDROID_PROJECT_BUILD":"$PLAYER_MOUNT/src-tauri/gen/android/build" \
    -v "$OWNER_ANDROID_BUILDSRC_BUILD":"$PLAYER_MOUNT/src-tauri/gen/android/buildSrc/build" \
    -v "$OWNER_ANDROID_BUILDSRC_GRADLE":"$PLAYER_MOUNT/src-tauri/gen/android/buildSrc/.gradle" \
    -v "$OWNER_ANDROID_BUILD":"$PLAYER_MOUNT/src-tauri/gen/android/app/build" \
    -v "$OWNER_ANDROID_GRADLE":"$PLAYER_MOUNT/src-tauri/gen/android/.gradle" \
    -v "$OWNER_ANDROID_GENERATED_JAVA":"$PLAYER_MOUNT/src-tauri/gen/android/app/src/main/java/jp/hatsuboshi/funkotplayer/generated" \
    -v "$OWNER_ANDROID_GENERATED_ASSETS":"$PLAYER_MOUNT/src-tauri/gen/android/app/src/main/assets" \
    -v "$OWNER_ANDROID_PROGUARD_TAURI":"$PLAYER_MOUNT/src-tauri/gen/android/app/proguard-tauri.pro" \
    -v "$OWNER_ANDROID_TAURI_BUILD_GRADLE":"$PLAYER_MOUNT/src-tauri/gen/android/app/tauri.build.gradle.kts" \
    -v "$OWNER_ANDROID_TAURI_PROPERTIES":"$PLAYER_MOUNT/src-tauri/gen/android/app/tauri.properties" \
    -v "$OWNER_ANDROID_TAURI_SETTINGS":"$PLAYER_MOUNT/src-tauri/gen/android/tauri.settings.gradle" \
    -v "$OWNER_ANDROID_JNI_VOLUME":"$PLAYER_MOUNT/src-tauri/gen/android/app/src/main/jniLibs" \
    -e CARGO_TARGET_DIR="$STORE_MOUNT" \
    -e CARGO_TERM_COLOR=never \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0="$CORE_MOUNT" \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    "$IMAGE" sh -c 'core=$1; shift; python3 scripts/dev_source_guard.py --source-root "$PWD" --source-root "$PWD/src-tauri" --source-root "$core" -- "$@"; status=$?; '"$CHOWN"'; exit $status' -- "$CORE_MOUNT" "$@"
status=$?
set -e
if [ "$MANAGED_OWNER" = 1 ]; then
    "$OWNER_INTERPRETER" "$PWD/scripts/lifecycle-product-owner.py" seal \
        --generation "$OWNER_GENERATION" --image "$IMAGE" --status "$status" -- "$@" || exit $?
fi
exit "$status"

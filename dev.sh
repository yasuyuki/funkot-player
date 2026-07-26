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
# /root/.android is a named volume on every run, not just for adb: the debug
# keystore lives there, and letting it be regenerated per build changes the APK
# signature and makes `adb install -r` fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE.
set -eu
cd "$(dirname "$0")"

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

# shellcheck disable=SC2086
exec docker run --rm -i $NET \
    -v "$PWD":/work/funkot-player \
    -v "$(cd "$CORE_DIR" && pwd)":/work/funkot-autodj-for-ui:ro \
    -v funkot-player-cargo-registry:/usr/local/cargo/registry \
    -v funkot-player-gradle:/root/.gradle \
    -v funkot-player-android-home:/root/.android \
    -e CARGO_TERM_COLOR=never \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    "$IMAGE" sh -c '"$@"; status=$?; '"$CHOWN"'; exit $status' -- "$@"

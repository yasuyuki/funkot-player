#!/bin/sh
# Install a build's APK onto the device that role is pinned to.
#
# There are two real devices for this project, and each is pinned to one
# role because debug and release are signed with different keys: installing
# the wrong role over the other fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE,
# and the only way out is `adb uninstall`, which wipes the app's data
# (queue, analysis cache, hand-corrected bar counts) with it. This script
# exists to make that mix-up impossible rather than merely documented.
#
# The key is the device's serial (ro.serialno), not the address you connect
# to. Wireless debugging's IP:port changes every time it is re-enabled, but
# the serial is fixed to the hardware, so the address is taken as an argument
# every time while the serial is checked against a fixed table below.
#
set -eu

cd "$(dirname "$0")/.."

# Update this table if a device is replaced or a role is reassigned:
ROLE_release_MODEL="Pixel 10 Pro"
ROLE_release_SERIAL="57301FDCH008G0"
ROLE_debug_MODEL="Pixel 8 Pro"
ROLE_debug_SERIAL="39181FDJG008C5"

usage() {
    echo "usage: $0 <debug|release> <adb-address>" >&2
    echo "  <adb-address> can also come from \$FUNKOT_ADB_ADDR" >&2
    echo "  example: $0 debug 192.168.10.129:35555" >&2
}

ROLE=${1:-}
ADDR=${2:-${FUNKOT_ADB_ADDR:-}}

if [ -z "$ROLE" ]; then
    usage
    exit 1
fi

case "$ROLE" in
    debug)
        MODEL=$ROLE_debug_MODEL
        SERIAL=$ROLE_debug_SERIAL
        APK="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
        BUILD_CMD="./dev.sh npx tauri android build --debug --target aarch64"
        ;;
    release)
        MODEL=$ROLE_release_MODEL
        SERIAL=$ROLE_release_SERIAL
        APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
        BUILD_CMD="./dev.sh npx tauri android build --target aarch64"
        ;;
    *)
        echo "unknown role '$ROLE' (expected debug or release)" >&2
        usage
        exit 1
        ;;
esac

if [ -z "$ADDR" ]; then
    usage
    exit 1
fi

if [ ! -f "$APK" ]; then
    echo "no $ROLE APK at $APK" >&2
    echo "build it first: $BUILD_CMD" >&2
    exit 1
fi

# One ./dev.sh call for connect + serial check + install. ADB=1 uses the
# persistent adb server (funkot-player-adb); connect here is idempotent and
# ensures ADDR is on that server's device list (wireless debugging's IP:port
# changes when re-enabled), not because each invocation used to wipe the
# server.
#
# The block below is deliberately single-quoted: it is a script for the
# container's shell, and $1..$5 there are its own positional params (bound
# from the `-- "$ADDR" ...` after the closing quote), not this shell's.
# shellcheck disable=SC2016
ADB=1 ./dev.sh sh -c '
    set -eu
    addr="$1"
    role="$2"
    model="$3"
    expected_serial="$4"
    apk="$5"

    adb connect "$addr"

    actual_serial=$(adb -s "$addr" shell getprop ro.serialno | tr -d "\r")
    actual_model=$(adb -s "$addr" shell getprop ro.product.model | tr -d "\r")

    if [ "$actual_serial" != "$expected_serial" ]; then
        echo "refusing to install: $addr is not the $role device" >&2
        echo "  expected: $role = $model (serial $expected_serial)" >&2
        echo "  found:    $actual_model (serial $actual_serial)" >&2
        echo "debug and release are signed differently -- installing the" >&2
        echo "wrong role here would fail or force an adb uninstall, which" >&2
        echo "wipes that device'\''s app data" >&2
        exit 1
    fi

    echo "confirmed $role device: $model ($expected_serial)"
    adb -s "$addr" install -r "$apk"
' -- "$ADDR" "$ROLE" "$MODEL" "$SERIAL" "$APK"

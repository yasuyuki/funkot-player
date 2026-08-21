#!/bin/sh
# Install a build's APK onto the device that role is pinned to.
#
# debug and release are signed with different keys, so each role is pinned to
# its own phone: installing the wrong role over the other fails with
# INSTALL_FAILED_UPDATE_INCOMPATIBLE, and the only way out is `adb uninstall`,
# which wipes the app's data (queue, analysis cache, hand-corrected bar counts)
# with it. This script exists to make that mix-up impossible rather than merely
# documented.
#
# Which phone is in which role is a property of the machine, not of this
# repository, so it is not recorded here -- `adb-device` owns that table and
# this script asks it by role. Nothing about anyone's hardware belongs in a
# public repo. Install adb-device from the android-device skill.
#
# The identity checked is the serial (ro.serialno). Wireless debugging's
# IP:port changes every time it is re-enabled; the serial does not.
set -eu

cd "$(dirname "$0")/.."

usage() {
    echo "usage: $0 <debug|release> [adb-address]" >&2
    echo "  the address is found automatically; pass one only to override" >&2
    echo "  (\$FUNKOT_ADB_ADDR works too). See \`adb-device --help\`" >&2
}

ROLE=${1:-}
ADDR=${2:-${FUNKOT_ADB_ADDR:-}}

if [ -z "$ROLE" ]; then
    usage
    exit 1
fi

if ! command -v adb-device >/dev/null 2>&1; then
    echo "adb-device is not on PATH" >&2
    echo "it holds this machine's device table (which phone is 'debug', which" >&2
    echo "is 'release') and finds them over wireless debugging. Install it from" >&2
    echo "the android-device skill, or pass an address and set it up later." >&2
    exit 1
fi

MODEL=$(adb-device --model "$ROLE") || { usage; exit 1; }
SERIAL=$(adb-device --serial "$ROLE")

case "$ROLE" in
    debug)
        APK="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
        BUILD_CMD="./dev.sh npx tauri android build --debug --target aarch64"
        ;;
    release)
        APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
        BUILD_CMD="./dev.sh npx tauri android build --target aarch64"
        ;;
    *)
        # adb-device's table can name roles this project has no build for.
        echo "no APK in this project for role '$ROLE' (expected debug or release)" >&2
        exit 1
        ;;
esac

# Check the APK before hunting for the device: a missing build is the common
# mistake, and finding a phone first can cost minutes.
if [ ! -f "$APK" ]; then
    echo "no $ROLE APK at $APK" >&2
    echo "build it first: $BUILD_CMD" >&2
    exit 1
fi

if [ -z "$ADDR" ]; then
    ADDR=$(adb-device "$ROLE") || exit 1
fi

# One ./dev.sh call for connect + serial check + install. ADB=1 uses the
# persistent adb server (funkot-player-adb); connect here is idempotent and
# ensures ADDR is on that server's device list (wireless debugging's IP:port
# changes when re-enabled), not because each invocation used to wipe the
# server.
#
# The serial is re-checked here even though adb-device already matched it,
# because an address given by hand skips that resolution entirely -- and this
# check is the one thing standing between a slip of the finger and a wiped
# phone.
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

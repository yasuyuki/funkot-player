#!/bin/sh
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
        echo "no APK in this project for role '$ROLE' (expected debug or release)" >&2
        exit 1
        ;;
esac

if [ ! -f "$APK" ]; then
    echo "no $ROLE APK at $APK" >&2
    echo "build it first: $BUILD_CMD" >&2
    exit 1
fi

if [ -z "$ADDR" ]; then
    ADDR=$(adb-device "$ROLE") || exit 1
fi

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

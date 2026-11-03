#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

LIB=src-tauri/src/lib.rs
PRO=src-tauri/gen/android/app/proguard-rules.pro

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

status=0

# Every app class Rust loads by name over JNI needs a `-keep ... { *; }` line.
#
# `load_class` and `call_static_method` take the class and the method as
# *strings*, so R8 sees no reference to either and is free to shrink or rename
# them. `{ *; }` is required rather than the class alone: keeping the class
# while its members are renamed fails in exactly the same way, so a bare
# `-keep class ...` line does not count and is reported as missing.
check_jni_keep_rules() {
    grep -o 'jni_str!("jp\.hatsuboshi\.funkotplayer\.[A-Za-z0-9_]*")' "$LIB" \
        | sed 's/^jni_str!("//; s/")$//' | sort -u > "$TMP/rust"
    grep -oE '^-keep class jp\.hatsuboshi\.funkotplayer\.[A-Za-z0-9_]+ *\{ *\*; *\}' "$PRO" \
        | sed -E 's/^-keep class //; s/ *\{ *\*; *\}$//' | sort -u > "$TMP/proguard"

    if diff "$TMP/rust" "$TMP/proguard"; then
        return 0
    fi
    echo "FAIL: JNI class names and R8 keep rules disagree." >&2
    echo "  '<' only in $LIB -- add '-keep class <name> { *; }' to $PRO" >&2
    echo "  '>' only in $PRO -- stale or misspelled keep rule; remove or fix it" >&2
    return 1
}

check_load_class_literals() {
    calls=$(grep -o 'load_class(' "$LIB" | wc -l | tr -d ' ')
    literals=$(grep -o 'jni_str!("jp\.hatsuboshi\.funkotplayer\.[A-Za-z0-9_]*")' "$LIB" \
        | wc -l | tr -d ' ')
    [ "$calls" = "$literals" ] && return 0
    echo "FAIL: $LIB has $calls load_class call(s) but $literals literal app-class name(s)." >&2
    echo "  A class name that is not a literal is invisible to the keep-rule check." >&2
    return 1
}

check_android_signed_release_build() {
    sh ./scripts/android-signed-release-build.test.sh
}

check_jni_keep_rules      || status=1
check_load_class_literals || status=1
check_android_signed_release_build || status=1

if [ "$status" = 0 ]; then
    echo "release-only invariants: OK"
fi
exit "$status"

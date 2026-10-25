#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script=$root/scripts/android-signed-release.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

player_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
engine_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
player=$tmp/owner/funkot-player
core=$tmp/owner/funkot-autodj-for-ui
calls=$tmp/calls

fail() {
    printf 'FAIL %s\n' "$1" >&2
    exit 1
}

must_have() {
    pattern=$1
    file=$2
    label=$3
    grep -q -- "$pattern" "$file" || {
        cat "$file" >&2
        fail "$label"
    }
}

must_not_have() {
    pattern=$1
    file=$2
    label=$3
    if grep -q -- "$pattern" "$file"; then
        cat "$file" >&2
        fail "$label"
    fi
}

mkdir -p "$tmp/bin" "$tmp/handoff" "$tmp/drop" \
    "$player/src-tauri/gen/android" "$player/.secrets" "$player/scripts" \
    "$core/.git"
: > "$player/src-tauri/Cargo.toml"
: > "$player/src-tauri/gen/android/keystore.properties"
: > "$player/.secrets/upload-keystore.jks"
: > "$calls"
printf 'PLAYER_SHA=%s\nENGINE_SHA=%s\n' "$player_sha" "$engine_sha" > "$tmp/handoff/p.meta"
: > "$tmp/handoff/p.bundle"

cat > "$tmp/bin/id" << 'EOF'
#!/bin/sh
if [ "${1:-}" = "-un" ]; then
    printf '%s\n' owner
    exit 0
fi
exec /usr/bin/id "$@"
EOF
chmod +x "$tmp/bin/id"

cat > "$tmp/bin/git" << 'EOF'
#!/bin/sh
set -eu
if [ "${1:-}" = "-C" ]; then
    shift 2
fi
if [ "${1:-}" = "rev-parse" ]; then
    printf '%s\n' "$FUNKOT_TEST_PLAYER_SHA"
fi
EOF
chmod +x "$tmp/bin/git"

cat > "$player/dev.sh" << 'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FUNKOT_TEST_CALLS"
case "${1:-}" in
    npx)
        mkdir -p src-tauri/gen/android/app/build/outputs/apk/universal/release
        : > src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
        ;;
    sh)
        if [ "${FUNKOT_TEST_CERT:-valid}" = invalid ]; then
            printf '%s\n' 'SHA-256 digest: invalid'
        else
            printf '%s\n' 'SHA-256 digest: b02a1ea592bb55da0502c37fa9d6d26870e05d2fd3b6ab79d8aad1c56a01a9e3'
        fi
        ;;
    adb)
        case "${2:-}" in
            devices)
                printf '%s\n' '10.0.0.2:5555 device product:fake model:Pixel_10_Pro'
                ;;
        esac
        ;;
esac
EOF
chmod +x "$player/dev.sh"

cat > "$player/scripts/check-funkot-core-commit.sh" << 'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$player/scripts/check-funkot-core-commit.sh"

cat > "$player/scripts/check-release-invariants.sh" << 'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$player/scripts/check-release-invariants.sh"

run_release() {
    PATH="$tmp/bin:$PATH" \
        FUNKOT_TEST_CALLS="$calls" \
        FUNKOT_TEST_PLAYER_SHA="$player_sha" \
        FUNKOT_OWNER_PLAYER="$player" \
        FUNKOT_HANDOFF_DIR="$tmp/handoff" \
        FUNKOT_APK_DROP="$tmp/drop/app.apk" \
        "$script" "$@"
}

run_release build
must_have '^npx tauri android build --target aarch64$' "$calls" 'build did not run the signed build command'
must_not_have '^adb ' "$calls" 'build probed or installed a connected device'
must_have "^PLAYER_SHA=$player_sha$" "$tmp/drop/app.apk.identity" 'build did not preserve player identity'
must_have "^ENGINE_SHA=$engine_sha$" "$tmp/drop/app.apk.identity" 'build did not preserve engine identity'

: > "$calls"
run_release install
must_have '^sh ' "$calls" 'install did not verify the APK certificate'
must_have '^adb devices -l$' "$calls" 'install did not select a connected device'
must_have '^adb -s 10.0.0.2:5555 install -r ' "$calls" 'install did not use adb install'

: > "$calls"
if FUNKOT_TEST_CERT=invalid run_release install >/dev/null 2>"$tmp/invalid-cert.err"; then
    fail 'install accepted an invalid certificate'
fi
must_have '^sh ' "$calls" 'invalid certificate was not checked'
must_not_have '^adb ' "$calls" 'invalid certificate reached adb'

echo 'android signed release build: OK'

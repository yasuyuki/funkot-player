#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script=$root/scripts/android-signed-release.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

real_git=$(command -v git)
seed=$tmp/seed
engine_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

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

mkdir -p "$tmp/bin" "$seed/src" "$seed/src-tauri" "$seed/scripts"
: > "$seed/src-tauri/Cargo.toml"
printf 'fn main() {}\n' > "$seed/src/main.rs"
printf '%s\n' '/.secrets/' '/src-tauri/gen/android/' > "$seed/.gitignore"
cp "$script" "$seed/scripts/android-signed-release.sh"
cp "$root/scripts/install-apk.sh" "$seed/scripts/install-apk.sh"

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
repo=$PWD
if [ "${1:-}" = "-C" ]; then
    repo=$(CDPATH= cd -- "$2" && pwd)
    shift 2
fi
if [ "$repo" = "$FUNKOT_TEST_CORE" ]; then
    if [ "${1:-}" = rev-parse ]; then
        printf '%s\n' "$FUNKOT_TEST_ENGINE_SHA"
    fi
    exit 0
fi
printf '%s\n' "$*" >> "$FUNKOT_TEST_GIT_CALLS"
exec "$FUNKOT_TEST_REAL_GIT" -C "$repo" "$@"
EOF
chmod +x "$tmp/bin/git"

cat > "$tmp/bin/adb-device" << 'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FUNKOT_TEST_ADB_DEVICE_CALLS"
[ "${FUNKOT_TEST_ROLE_REGISTERED:-1}" = 1 ] || exit 1
case "${1:-}" in
    --model)
        [ "${2:-}" = release ] || exit 1
        printf '%s\n' Pixel_10_Pro
        ;;
    --serial)
        [ "${2:-}" = release ] || exit 1
        [ "${FUNKOT_TEST_EXPECTED_SERIAL_STATUS:-ok}" = ok ] || exit 1
        printf '%s\n' "${FUNKOT_TEST_EXPECTED_SERIAL-release-serial}"
        ;;
    release)
        [ "${FUNKOT_TEST_ROLE_RESOLVABLE:-1}" = 1 ] || exit 1
        printf '%s\n' "${FUNKOT_TEST_ROLE_ADDR:-10.0.0.9:5555}"
        ;;
    *)
        exit 1
        ;;
esac
EOF
chmod +x "$tmp/bin/adb-device"

cat > "$tmp/bin/adb" << 'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FUNKOT_TEST_ADB_CALLS"
case "${1:-}" in
    connect)
        exit 0
        ;;
    devices)
        printf '%s\n' \
            '10.0.0.2:5555 device product:wrong model:Pixel_10_Pro' \
            '10.0.0.9:5555 device product:release model:Pixel_10_Pro'
        exit 0
        ;;
esac
[ "${1:-}" = -s ] || exit 1
addr=$2
shift 2
case "${1:-}" in
    shell)
        case "${2:-}" in
            getprop)
                case "${3:-}" in
                    ro.serialno)
                        case "${FUNKOT_TEST_ACTUAL_SERIAL_STATUS:-ok}" in
                            fail)
                                exit 1
                                ;;
                            matching-output-fails)
                                printf '%s\n' "${FUNKOT_TEST_ACTUAL_SERIAL-release-serial}"
                                exit 1
                                ;;
                        esac
                        printf '%s\n' "${FUNKOT_TEST_ACTUAL_SERIAL-release-serial}"
                        ;;
                    ro.product.model)
                        printf '%s\n' Pixel_10_Pro
                        ;;
                esac
                ;;
        esac
        ;;
    install)
        if [ -n "${FUNKOT_TEST_INSTALL_MARKER:-}" ]; then
            : > "$FUNKOT_TEST_INSTALL_MARKER"
            printf '%s\n' "$addr" > "$FUNKOT_TEST_INSTALL_ADDR"
        fi
        ;;
esac
EOF
chmod +x "$tmp/bin/adb"

cat > "$seed/dev.sh" << 'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FUNKOT_TEST_CALLS"
case "${1:-}" in
    npx)
        mkdir -p src-tauri/gen/android/app/build/outputs/apk/universal/release
        : > src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
        ;;
    sh)
        case "${3:-}" in
            *apksigner*)
                if [ "${FUNKOT_TEST_CERT:-valid}" = invalid ]; then
                    printf '%s\n' 'SHA-256 digest: invalid'
                else
                    printf '%s\n' 'SHA-256 digest: b02a1ea592bb55da0502c37fa9d6d26870e05d2fd3b6ab79d8aad1c56a01a9e3'
                fi
                ;;
            *)
                shell=$3
                shift 4
                sh -c "$shell" -- "$@"
                ;;
        esac
        ;;
    adb)
        shift
        exec adb "$@"
        ;;
esac
EOF
chmod +x "$seed/dev.sh"

cat > "$seed/scripts/check-funkot-core-commit.sh" << 'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$seed/scripts/check-funkot-core-commit.sh"

cat > "$seed/scripts/check-release-invariants.sh" << 'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$seed/scripts/check-release-invariants.sh"

"$real_git" -c init.defaultBranch=fixture init -q "$seed"
"$real_git" -C "$seed" config user.name 'Signed release test'
"$real_git" -C "$seed" config user.email 'signed-release-test@example.invalid'
"$real_git" -C "$seed" config core.hooksPath .git/hooks
"$real_git" -C "$seed" add .gitignore src src-tauri/Cargo.toml dev.sh scripts
"$real_git" -C "$seed" -c commit.gpgsign=false commit -qm 'Fixture base'
base_sha=$("$real_git" -C "$seed" rev-parse HEAD)
printf 'requested revision\n' > "$seed/release.txt"
"$real_git" -C "$seed" add release.txt
"$real_git" -C "$seed" -c commit.gpgsign=false commit -qm 'Requested player revision'
player_sha=$("$real_git" -C "$seed" rev-parse HEAD)

new_fixture() {
    case_dir=$tmp/$1
    player=$case_dir/owner/funkot-player
    core=$case_dir/owner/funkot-autodj-for-ui
    handoff=$case_dir/handoff
    calls=$case_dir/calls
    git_calls=$case_dir/git-calls
    adb_calls=$case_dir/adb-calls
    adb_device_calls=$case_dir/adb-device-calls
    mkdir -p "$case_dir/owner" "$core/.git" "$handoff" "$case_dir/drop"
    "$real_git" clone -q --no-hardlinks "$seed" "$player"
    "$real_git" -C "$player" config core.hooksPath .git/hooks
    mkdir -p "$player/src-tauri/gen/android" "$player/.secrets"
    : > "$player/src-tauri/gen/android/keystore.properties"
    : > "$player/.secrets/upload-keystore.jks"
    : > "$calls"
    : > "$git_calls"
    : > "$adb_calls"
    : > "$adb_device_calls"
    printf 'PLAYER_SHA=%s\nENGINE_SHA=%s\n' "$player_sha" "$engine_sha" > "$handoff/p.meta"
    "$real_git" -C "$seed" bundle create "$handoff/p.bundle" HEAD
}

run_release() {
    PATH="$tmp/bin:$PATH" \
        FUNKOT_TEST_CALLS="$calls" \
        FUNKOT_TEST_GIT_CALLS="$git_calls" \
        FUNKOT_TEST_REAL_GIT="$real_git" \
        FUNKOT_TEST_CORE="$core" \
        FUNKOT_TEST_ENGINE_SHA="$engine_sha" \
        FUNKOT_TEST_ADB_CALLS="$adb_calls" \
        FUNKOT_TEST_ADB_DEVICE_CALLS="$adb_device_calls" \
        FUNKOT_OWNER_PLAYER="$player" \
        FUNKOT_HANDOFF_DIR="$handoff" \
        FUNKOT_APK_DROP="$case_dir/drop/app.apk" \
        "$player/scripts/android-signed-release.sh" "$@"
}

snapshot_tree() (
    CDPATH= cd -- "$1"
    find . -type f -exec sha256sum {} \; | LC_ALL=C sort > "$2"
)

new_fixture clean
[ -z "$("$real_git" -C "$player" status --porcelain)" ] || fail 'clean fixture has nonignored changes'
run_release prepare
must_have "^PLAYER_SHA=$player_sha$" "$handoff/p.meta" 'prepare did not export the fixed player SHA'
"$real_git" -C "$player" bundle verify "$handoff/p.bundle" > /dev/null 2>&1

run_release build
must_have '^npx tauri android build --target aarch64$' "$calls" 'build did not run the signed build command'
must_not_have '^adb ' "$calls" 'build probed or installed a connected device'
must_have "^PLAYER_SHA=$player_sha$" "$case_dir/drop/app.apk.identity" 'build did not preserve player identity'
must_have "^ENGINE_SHA=$engine_sha$" "$case_dir/drop/app.apk.identity" 'build did not preserve engine identity'

: > "$calls"
run_release install
must_have '^sh ' "$calls" 'install did not verify the APK certificate'
must_not_have '^adb ' "$calls" 'install bypassed the role-aware installer'
must_have '^release$' "$adb_device_calls" 'install did not resolve the release role'
must_have '^-s 10.0.0.9:5555 install -r ' "$adb_calls" 'install did not use the release role address'

: > "$calls"
if FUNKOT_TEST_CERT=invalid run_release install >/dev/null 2>"$tmp/invalid-cert.err"; then
    fail 'install accepted an invalid certificate'
fi
must_have '^sh ' "$calls" 'invalid certificate was not checked'
must_not_have '^adb ' "$calls" 'invalid certificate reached adb'

echo 'PASS clean fixed-SHA prepare/build, build/install separation and invalid certificate'

role_install_fixture() {
    new_fixture "$1"
    : > "$case_dir/drop/app.apk"
    : > "$case_dir/adb-calls"
    : > "$case_dir/adb-device-calls"
    install_marker=$case_dir/install-ran
    install_addr=$case_dir/install-addr
}

run_role_install() {
    PATH="$tmp/bin:$PATH" \
        FUNKOT_TEST_ADB_CALLS="$case_dir/adb-calls" \
        FUNKOT_TEST_ADB_DEVICE_CALLS="$case_dir/adb-device-calls" \
        FUNKOT_TEST_INSTALL_MARKER="$install_marker" \
        FUNKOT_TEST_INSTALL_ADDR="$install_addr" \
        "$@"
}

role_install_accepts_matching_serial() {
    role_install_fixture matching-role
    run_role_install run_release install > "$case_dir/release.log" 2>&1
    [ -f "$install_marker" ] || {
        cat "$case_dir/release.log" >&2
        fail 'matching release serial did not install'
    }
    [ "$(cat "$install_addr")" = 10.0.0.9:5555 ] ||
        fail "matching role installed on $(cat "$install_addr") instead of the release device"
    must_have '^release$' "$case_dir/adb-device-calls" 'install did not resolve the release role'
    must_not_have '^adb devices -l$' "$calls" 'install selected the first matching model instead of the release role'
    echo 'PASS install uses the release role serial instead of the first matching model'
}

role_install_rejects() {
    label=$1
    role_install_fixture "$label"
    status=0
    (
        case "$label" in
            direct-address-mismatch)
                export FUNKOT_ADB_ADDR=10.0.0.2:5555
                export FUNKOT_TEST_ACTUAL_SERIAL=wrong-serial
                ;;
            unregistered-role)
                export FUNKOT_TEST_ROLE_REGISTERED=0
                ;;
            expected-serial-unavailable)
                export FUNKOT_TEST_EXPECTED_SERIAL_STATUS=fail
                ;;
            empty-expected-serial)
                export FUNKOT_TEST_EXPECTED_SERIAL=
                ;;
            actual-serial-unavailable)
                export FUNKOT_TEST_ACTUAL_SERIAL_STATUS=fail
                ;;
            matching-serial-command-fails)
                export FUNKOT_TEST_ACTUAL_SERIAL_STATUS=matching-output-fails
                ;;
            empty-actual-serial)
                export FUNKOT_TEST_ACTUAL_SERIAL=
                ;;
            ambiguous-role-candidates)
                export FUNKOT_TEST_ROLE_RESOLVABLE=0
                ;;
        esac
        run_role_install run_release install
    ) > "$case_dir/release.log" 2>&1 || status=$?
    [ "$status" -ne 0 ] || {
        cat "$case_dir/release.log" >&2
        if [ -e "$install_marker" ]; then
            fail "$label installed on $(cat "$install_addr")"
        fi
        fail "$label unexpectedly succeeded"
    }
    [ ! -e "$install_marker" ] || fail "$label reached adb install"
    echo "PASS install refuses $label"
}

role_install_accepts_matching_serial
role_install_rejects direct-address-mismatch
role_install_rejects unregistered-role
role_install_rejects expected-serial-unavailable
role_install_rejects empty-expected-serial
role_install_rejects actual-serial-unavailable
role_install_rejects matching-serial-command-fails
role_install_rejects empty-actual-serial
role_install_rejects ambiguous-role-candidates

refuse_changed_player() {
    mode=$1
    state=$2
    new_fixture "$mode-$state"
    case "$state" in
        unstaged)
            printf '// owner unstaged edit\n' >> "$player/src/main.rs"
            ;;
        staged)
            printf '// owner staged edit\n' >> "$player/src/main.rs"
            "$real_git" -C "$player" add src/main.rs
            ;;
        untracked)
            printf 'fn extra() {}\n' > "$player/src/extra.rs"
            ;;
        merge)
            printf '%s\n' "$base_sha" > "$player/.git/MERGE_HEAD"
            printf 'Unfinished owner merge\n' > "$player/.git/MERGE_MSG"
            [ -z "$("$real_git" -C "$player" status --porcelain)" ] || fail 'merge fixture must have clean files'
            ;;
        assume-unchanged)
            "$real_git" -C "$player" update-index --assume-unchanged src/main.rs
            printf '// owner edit hidden by index flags\n' >> "$player/src/main.rs"
            [ -z "$("$real_git" -C "$player" status --porcelain)" ] || fail 'assume-unchanged fixture must hide the source edit'
            ;;
    esac
    "$real_git" -C "$player" status --porcelain > /dev/null
    snapshot_tree "$player" "$case_dir/player.before"
    snapshot_tree "$handoff" "$case_dir/handoff.before"
    release_status=0
    run_release "$mode" > "$case_dir/release.log" 2>&1 || release_status=$?
    if [ "$release_status" -eq 0 ]; then
        cat "$case_dir/release.log" >&2
    fi
    must_not_have '^npx tauri android build ' "$calls" "$mode $state started signed build"
    [ "$release_status" -ne 0 ] || fail "$mode accepted $state player state"
    if [ "$mode" = build ]; then
        must_not_have '^fetch ' "$git_calls" "build $state fetched before refusal"
        must_not_have '^merge ' "$git_calls" "build $state merged before refusal"
    else
        must_not_have '^bundle create ' "$git_calls" "prepare $state exported a bundle before refusal"
    fi
    snapshot_tree "$player" "$case_dir/player.after"
    cmp "$case_dir/player.before" "$case_dir/player.after" || fail "$mode $state changed owner source, index or Git state"
    snapshot_tree "$handoff" "$case_dir/handoff.after"
    cmp "$case_dir/handoff.before" "$case_dir/handoff.after" || fail "$mode $state changed the handoff"
    [ ! -e "$case_dir/drop/app.apk" ] || fail "$mode $state published an APK"
    echo "PASS $mode refuses $state and preserves owner state and handoff"
}

refuse_post_sync_change() {
    new_fixture post-sync
    "$real_git" -C "$player" checkout -q --detach "$base_sha"
    mkdir -p "$case_dir/after-sync"
    cat > "$player/.git/hooks/post-merge" << 'EOF'
#!/bin/sh
set -eu
printf '// owner edit during sync\n' >> src/main.rs
find . -type f -exec sha256sum {} \; | LC_ALL=C sort > "$FUNKOT_TEST_AFTER_SYNC/state"
: > "$FUNKOT_TEST_AFTER_SYNC/ran"
EOF
    chmod +x "$player/.git/hooks/post-merge"
    release_status=0
    FUNKOT_TEST_AFTER_SYNC="$case_dir/after-sync" run_release build > "$case_dir/release.log" 2>&1 || release_status=$?
    [ -f "$case_dir/after-sync/ran" ] || {
        cat "$case_dir/release.log" >&2
        fail 'post-sync fixture did not run its real post-merge hook'
    }
    [ "$("$real_git" -C "$player" rev-parse HEAD)" = "$player_sha" ] || fail 'post-sync fixture did not reach the requested SHA'
    if [ "$release_status" -eq 0 ]; then
        cat "$case_dir/release.log" >&2
    fi
    must_not_have '^npx tauri android build ' "$calls" 'post-sync source edit reached signed build'
    [ "$release_status" -ne 0 ] || fail 'build accepted a post-sync source edit'
    snapshot_tree "$player" "$case_dir/player.after"
    cmp "$case_dir/after-sync/state" "$case_dir/player.after" || fail 'post-sync refusal changed owner source, index or Git state'
    [ ! -e "$case_dir/drop/app.apk" ] || fail 'post-sync refusal published an APK'
    echo 'PASS build rechecks source after real fast-forward sync'
}

failures=0
for mode in build prepare; do
    for state in unstaged staged untracked merge assume-unchanged; do
        (refuse_changed_player "$mode" "$state") || failures=$((failures + 1))
    done
done
(refuse_post_sync_change) || failures=$((failures + 1))
[ "$failures" -eq 0 ] || fail "$failures player source-state regressions"
echo 'android signed release build: OK'

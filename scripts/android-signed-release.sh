#!/bin/sh
# Signed Android release across two Unix users.
#
# The signing checkout cannot see the agent tree, and the agent must not see
# signing material. Source moves over a Windows-side git bundle; the APK
# comes back through a group-writable drop directory.
#
#   prepare  — agent source tree: write bundle + Windows launcher
#   build    — owner (yasuyuki): sync, signed build, drop APK, install if a
#              matching phone is already on adb
#   install  — either user: verify cert and adb install -r
#   pair / connect / status
#
# Human leftovers: wireless-debug pairing (code is only on the phone), and
# running `build` as the owner so Gradle can read the keystore in that tree.
#
# Host paths default to this machine and are overridable:
#   FUNKOT_HANDOFF_DIR  Windows-visible dir (bundle + apk.sh)
#   FUNKOT_APK_DROP     signed APK destination
#   FUNKOT_OWNER_PLAYER owner funkot-player checkout
#   FUNKOT_ADB_ADDR     adb selector (skip model search)
#   FUNKOT_RELEASE_MODEL  adb devices -l model: token (default Pixel_10_Pro)
set -eu

EXPECTED_CERT_SHA256=b02a1ea592bb55da0502c37fa9d6d26870e05d2fd3b6ab79d8aad1c56a01a9e3
APK_REL=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk

die() { echo "$*" >&2; exit 1; }

usage() {
    echo "usage: $0 prepare|build|install|pair|connect|status [args]" >&2
    echo "  pair <ip> <pair-port> <code> [connect-port]" >&2
    echo "  connect <ip:port>" >&2
}

handoff_dir() {
    if [ -n "${FUNKOT_HANDOFF_DIR:-}" ]; then
        printf '%s\n' "$FUNKOT_HANDOFF_DIR"
        return
    fi
    if [ -d /mnt/c/Users/flame/work ]; then
        printf '%s\n' /mnt/c/Users/flame/work
        return
    fi
    die "set FUNKOT_HANDOFF_DIR to a directory both WSL users can read"
}

drop_apk() {
    if [ -n "${FUNKOT_APK_DROP:-}" ]; then
        printf '%s\n' "$FUNKOT_APK_DROP"
        return
    fi
    printf '%s\n' /srv/funkot-agent/incoming-apk/app-universal-release.apk
}

owner_player() {
    if [ -n "${FUNKOT_OWNER_PLAYER:-}" ]; then
        printf '%s\n' "$FUNKOT_OWNER_PLAYER"
        return
    fi
    if [ -d "$HOME/Projects/funkot-player" ]; then
        printf '%s\n' "$HOME/Projects/funkot-player"
        return
    fi
    die "set FUNKOT_OWNER_PLAYER to the signing funkot-player checkout"
}

# Source tree that has ./dev.sh. prepare uses the checkout we were started from
# when this file lives in scripts/; otherwise cwd if it looks like the player.
player_root() {
    d=$(CDPATH= cd "$(dirname "$0")" && pwd)
    if [ -f "$d/../dev.sh" ] && [ -f "$d/../src-tauri/Cargo.toml" ]; then
        CDPATH= cd "$d/.." && pwd
        return
    fi
    if [ -f "$PWD/dev.sh" ] && [ -f "$PWD/src-tauri/Cargo.toml" ]; then
        printf '%s\n' "$PWD"
        return
    fi
    die "run this from a funkot-player checkout (need ./dev.sh)"
}

require_owner_user() {
    [ "$(id -un)" != "funkot-agent" ] || die "run build/pair as the owner, not funkot-agent"
}

load_meta() {
    meta=$(handoff_dir)/p.meta
    [ -f "$meta" ] || die "missing $meta — run prepare from the agent tree first"
    PLAYER_SHA=$(sed -n 's/^PLAYER_SHA=//p' "$meta")
    ENGINE_SHA=$(sed -n 's/^ENGINE_SHA=//p' "$meta")
    [ -n "$PLAYER_SHA" ] || die "PLAYER_SHA missing in $meta"
    [ -n "$ENGINE_SHA" ] || die "ENGINE_SHA missing in $meta"
}

adb_do() {
    player=$1
    shift
    (CDPATH= cd "$player" && ADB=1 ./dev.sh adb "$@")
}

verify_cert() {
    player=$1
    apk=$2
    [ -f "$player/$apk" ] || die "no APK at $player/$apk"
    cert=$(
        CDPATH= cd "$player" && ./dev.sh sh -c '
            set -eu
            apk="$1"
            signer=$(ls /opt/android-sdk/build-tools/*/apksigner | tail -1)
            "$signer" verify --print-certs "$apk"
        ' -- "$apk"
    )
    echo "$cert" | grep -q "SHA-256 digest: $EXPECTED_CERT_SHA256" || {
        echo "$cert" >&2
        die "APK certificate is not the 0.1.6 release key"
    }
    echo "cert ok ($EXPECTED_CERT_SHA256)"
}

pick_addr() {
    player=$1
    if [ -n "${FUNKOT_ADB_ADDR:-}" ]; then
        printf '%s\n' "$FUNKOT_ADB_ADDR"
        return
    fi
    model=${FUNKOT_RELEASE_MODEL:-Pixel_10_Pro}
    addr=$(adb_do "$player" devices -l | awk -v m="model:$model" '
        $2 == "device" && index($0, m) { print $1; exit }
    ')
    [ -n "$addr" ] || return 1
    printf '%s\n' "$addr"
}

install_apk() {
    player=$1
    apk=$2
    verify_cert "$player" "$apk"
    addr=$(pick_addr "$player") || {
        adb_do "$player" devices -l >&2 || true
        die "no ${FUNKOT_RELEASE_MODEL:-Pixel_10_Pro} on adb. pair/connect, then: $0 install"
    }
    model=$(adb_do "$player" -s "$addr" shell getprop ro.product.model | tr -d '\r')
    echo "installing on $model ($addr)"
    adb_do "$player" -s "$addr" install -r "$apk"
    adb_do "$player" -s "$addr" shell dumpsys package jp.hatsuboshi.funkotplayer \
        | grep -E 'versionName=|versionCode=' | head -2
}

cmd_prepare() {
    player=$(player_root)
    CDPATH= cd "$player"
    [ "$(id -un)" = "funkot-agent" ] || echo "warning: prepare is meant to run in the agent tree" >&2

    core=$player/../funkot-autodj-for-ui
    [ -d "$core/.git" ] || die "missing sibling funkot-autodj-for-ui at $core"

    handoff=$(handoff_dir)
    drop=$(drop_apk)
    mkdir -p "$handoff" "$(dirname "$drop")"
    chmod 2775 "$(dirname "$drop")" 2>/dev/null || true

    player_sha=$(git rev-parse HEAD)
    engine_sha=$(git -C "$core" rev-parse HEAD)
    git bundle create "$handoff/p.bundle" HEAD
    printf 'PLAYER_SHA=%s\nENGINE_SHA=%s\n' "$player_sha" "$engine_sha" > "$handoff/p.meta"
    cp -f "$player/scripts/android-signed-release.sh" "$handoff/android-signed-release.sh"
    chmod 755 "$handoff/android-signed-release.sh"
    cat > "$handoff/apk.sh" << 'EOF'
#!/bin/sh
exec "$(dirname "$0")/android-signed-release.sh" "$@"
EOF
    chmod 755 "$handoff/apk.sh"

    echo "bundle $(git rev-parse --short HEAD) engine $(git -C "$core" rev-parse --short HEAD)"
    echo "owner (success: copied / cert ok / Success):"
    echo "  $handoff/apk.sh build"
}

cmd_build() {
    require_owner_user
    load_meta
    player=$(owner_player)
    [ -d "$player" ] || die "missing $player"
    CDPATH= cd "$player"

    [ -f src-tauri/gen/android/keystore.properties ] \
        || die "missing keystore.properties in the owner checkout"
    [ -f .secrets/upload-keystore.jks ] \
        || die "missing .secrets/upload-keystore.jks in the owner checkout"

    handoff=$(handoff_dir)
    [ -f "$handoff/p.bundle" ] || die "missing $handoff/p.bundle — agent must run prepare"

    echo "sync player $(printf '%.12s' "$PLAYER_SHA")"
    git fetch "$handoff/p.bundle" HEAD
    git merge --ff-only FETCH_HEAD
    [ "$(git rev-parse HEAD)" = "$PLAYER_SHA" ] \
        || die "HEAD is $(git rev-parse HEAD), expected $PLAYER_SHA"

    core=$player/../funkot-autodj-for-ui
    [ -d "$core/.git" ] || die "missing $core — clone funkot-autodj as funkot-autodj-for-ui"
    echo "sync engine $(printf '%.12s' "$ENGINE_SHA")"
    git -C "$core" fetch origin
    git -C "$core" checkout "$ENGINE_SHA"

    ./scripts/check-release-invariants.sh
    ./dev.sh npx tauri android build --target aarch64
    [ -f "$APK_REL" ] || die "signed APK not produced (unsigned-only cannot be installed)"

    drop=$(drop_apk)
    mkdir -p "$(dirname "$drop")"
    cp -f "$APK_REL" "$drop"
    chmod 644 "$drop"
    echo "copied $drop"

    if pick_addr "$player" >/dev/null; then
        install_apk "$player" "$APK_REL"
    else
        echo "phone not on adb; APK is ready. pair/connect, then:"
        echo "  $handoff/apk.sh install"
    fi
}

cmd_install() {
    drop=$(drop_apk)
    if [ "$(id -un)" = "funkot-agent" ]; then
        player=$(player_root)
        apk=$drop
        [ -f "$apk" ] || die "missing $apk — owner must run build"
        dest=$player/$APK_REL
        mkdir -p "$(dirname "$dest")"
        cp -f "$apk" "$dest"
    else
        player=$(owner_player)
        if [ ! -f "$player/$APK_REL" ]; then
            [ -f "$drop" ] || die "missing signed APK (build first)"
            mkdir -p "$(dirname "$player/$APK_REL")"
            cp -f "$drop" "$player/$APK_REL"
        fi
    fi
    install_apk "$player" "$APK_REL"
}

cmd_pair() {
    require_owner_user
    [ "$#" -ge 3 ] || die "usage: $0 pair <ip> <pair-port> <code> [connect-port]"
    ip=$1
    pair_port=$2
    code=$3
    connect_port=${4:-}
    player=$(owner_player)
    adb_do "$player" pair "$ip:$pair_port" "$code"
    if [ -n "$connect_port" ]; then
        adb_do "$player" connect "$ip:$connect_port"
    fi
    adb_do "$player" devices -l
}

cmd_connect() {
    [ "$#" -eq 1 ] || die "usage: $0 connect <ip:port>"
    if [ "$(id -un)" = "funkot-agent" ]; then
        player=$(player_root)
    else
        player=$(owner_player)
    fi
    adb_do "$player" connect "$1"
    adb_do "$player" devices -l
}

cmd_status() {
    handoff=$(handoff_dir)
    drop=$(drop_apk)
    echo "handoff $handoff"
    if [ -f "$handoff/p.meta" ]; then
        cat "$handoff/p.meta"
    else
        echo "p.meta: absent"
    fi
    if [ -f "$drop" ]; then
        ls -l "$drop"
    else
        echo "apk: absent"
    fi
    if [ "$(id -un)" = "funkot-agent" ] && player=$(player_root 2>/dev/null); then
        adb_do "$player" devices -l || true
    elif player=$(owner_player 2>/dev/null); then
        adb_do "$player" devices -l || true
    fi
}

cmd=${1:-}
[ -n "$cmd" ] || { usage; exit 1; }
shift
case "$cmd" in
    prepare) cmd_prepare "$@" ;;
    build) cmd_build "$@" ;;
    install) cmd_install "$@" ;;
    pair) cmd_pair "$@" ;;
    connect) cmd_connect "$@" ;;
    status) cmd_status "$@" ;;
    *) usage; exit 1 ;;
esac

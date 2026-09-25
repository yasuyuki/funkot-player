#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script=$root/scripts/android-signed-release.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

sha_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
sha_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

plan() {
    env -u FUNKOT_OWNER_PLAYER \
        FUNKOT_HANDOFF_DIR="$tmp/handoff" \
        FUNKOT_APK_DROP="$tmp/drop/app.apk" \
        HOME="$tmp/home" \
        "$script" plan
}

must_eq() {
    got=$1
    want=$2
    label=$3
    if [ "$got" != "$want" ]; then
        printf 'FAIL %s\n got:\n%s\n want:\n%s\n' "$label" "$got" "$want" >&2
        exit 1
    fi
}

mkdir -p "$tmp/handoff" "$tmp/drop" "$tmp/home/Projects/funkot-player"
: > "$tmp/drop/app.apk"

must_eq "$(plan)" "$(printf '%s\n' \
    'next=prepare' \
    'owner=n/a' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'missing meta prepares'

printf 'PLAYER_SHA=%s\nENGINE_SHA=%s\n' "$sha_a" "$sha_b" > "$tmp/handoff/p.meta"
must_eq "$(plan)" "$(printf '%s\n' \
    'next=build' \
    'owner=missing' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'stale Projects default is not an owner'

printf '%s\n' "$tmp/home/not-a-checkout" > "$tmp/handoff/owner.path"
must_eq "$(plan)" "$(printf '%s\n' \
    'next=build' \
    'owner=set' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'owner.path counts without statting it'

printf 'PLAYER_SHA=%s\nENGINE_SHA=%s\n' "$sha_a" "$sha_b" > "$tmp/drop/app.apk.identity"
must_eq "$(plan)" "$(printf '%s\n' \
    'next=reuse' \
    'owner=set' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'matching drop is reused'

printf 'PLAYER_SHA=%s\nENGINE_SHA=%s\n' "$sha_b" "$sha_a" > "$tmp/drop/app.apk.identity"
must_eq "$(plan)" "$(printf '%s\n' \
    'next=build' \
    'owner=set' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'different drop identity builds'

out=$(plan)
printf '%s\n' "$out" | grep -q 'adb pair' && {
    echo 'FAIL plan suggested host adb pair' >&2
    exit 1
}
printf '%s\n' "$out" | grep -q 'gh ' && {
    echo 'FAIL plan suggested sandbox gh' >&2
    exit 1
}

if "$script" pair >/dev/null 2>"$tmp/pair.err"; then
    echo 'FAIL pair ran as funkot-agent' >&2
    exit 1
fi
grep -q 'apk.sh pair' "$tmp/pair.err"
grep -q 'adb pair' "$tmp/pair.err" && {
    echo 'FAIL pair error suggested adb pair' >&2
    exit 1
}

# --- owner-set ---
rm -f "$tmp/handoff/owner.path"

if env -u FUNKOT_OWNER_PLAYER \
    FUNKOT_HANDOFF_DIR="$tmp/handoff" \
    FUNKOT_APK_DROP="$tmp/drop/app.apk" \
    HOME="$tmp/home" \
    "$script" owner-set "$tmp/home" >/dev/null 2>"$tmp/owner-set-agent.err"
then
    echo 'FAIL owner-set ran as funkot-agent' >&2
    exit 1
fi
grep -q 'funkot-agent' "$tmp/owner-set-agent.err"
grep -q 'adb' "$tmp/owner-set-agent.err" && {
    echo 'FAIL owner-set agent error suggested adb' >&2
    exit 1
}
[ ! -e "$tmp/handoff/owner.path" ] || {
    echo 'FAIL owner-set wrote owner.path as funkot-agent' >&2
    exit 1
}

preserved=$tmp/preserved-owner-value
printf '%s\n' "$preserved" > "$tmp/handoff/owner.path"
before=$(cat "$tmp/handoff/owner.path")

mkdir -p "$tmp/bin"
cat > "$tmp/bin/id" << 'EOF'
#!/bin/sh
if [ "${1:-}" = "-un" ]; then
    printf '%s\n' owner
    exit 0
fi
exec /usr/bin/id "$@"
EOF
chmod +x "$tmp/bin/id"

if env -u FUNKOT_OWNER_PLAYER \
    PATH="$tmp/bin:$PATH" \
    FUNKOT_HANDOFF_DIR="$tmp/handoff" \
    FUNKOT_APK_DROP="$tmp/drop/app.apk" \
    HOME="$tmp/home" \
    "$script" owner-set "$tmp/home/not-a-checkout" >/dev/null 2>"$tmp/owner-set-bad.err"
then
    echo 'FAIL owner-set accepted non-checkout' >&2
    exit 1
fi
must_eq "$(cat "$tmp/handoff/owner.path")" "$before" \
    'failed owner-set left owner.path unchanged'

mkdir -p "$tmp/fake-player/src-tauri/gen/android" "$tmp/fake-player/.secrets"
fake=$(CDPATH= cd -- "$tmp/fake-player" && pwd)
: > "$fake/dev.sh"
: > "$fake/src-tauri/Cargo.toml"
: > "$fake/src-tauri/gen/android/keystore.properties"
: > "$fake/.secrets/upload-keystore.jks"

got=$(env -u FUNKOT_OWNER_PLAYER \
    PATH="$tmp/bin:$PATH" \
    FUNKOT_HANDOFF_DIR="$tmp/handoff" \
    FUNKOT_APK_DROP="$tmp/drop/app.apk" \
    HOME="$tmp/home" \
    "$script" owner-set "$fake")
must_eq "$got" "$fake" 'owner-set prints checkout path'
must_eq "$(cat "$tmp/handoff/owner.path")" "$(printf '%s\n' "$fake")" \
    'owner.path stores absolute checkout'

must_eq "$(plan)" "$(printf '%s\n' \
    'next=build' \
    'owner=set' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'plan sees registered owner'

rm -f "$tmp/handoff/owner.path"
must_eq "$(
    FUNKOT_OWNER_PLAYER="$fake" \
        FUNKOT_HANDOFF_DIR="$tmp/handoff" \
        FUNKOT_APK_DROP="$tmp/drop/app.apk" \
        HOME="$tmp/home" \
        "$script" plan
)" "$(printf '%s\n' \
    'next=build' \
    'owner=set' \
    'pair=use-apk-sh' \
    'github_read=connector-or-approved-gh')" \
    'FUNKOT_OWNER_PLAYER sets plan owner without owner.path'

printf '%s\n' "$tmp/stale-not-a-dir" > "$tmp/handoff/owner.path"
if env -u FUNKOT_OWNER_PLAYER \
    PATH="$tmp/bin:$PATH" \
    FUNKOT_HANDOFF_DIR="$tmp/handoff" \
    FUNKOT_APK_DROP="$tmp/drop/app.apk" \
    HOME="$tmp/home" \
    "$script" build >/dev/null 2>"$tmp/build-stale.err"
then
    echo 'FAIL build succeeded with stale owner.path' >&2
    exit 1
fi
grep -q 'owner-set' "$tmp/build-stale.err" || {
    echo 'FAIL stale owner.path build missing owner-set message' >&2
    cat "$tmp/build-stale.err" >&2
    exit 1
}

if env \
    PATH="$tmp/bin:$PATH" \
    FUNKOT_OWNER_PLAYER="$fake" \
    FUNKOT_HANDOFF_DIR="$tmp/handoff" \
    FUNKOT_APK_DROP="$tmp/drop/app.apk" \
    HOME="$tmp/home" \
    "$script" build >/dev/null 2>"$tmp/build-override.err"
then
    echo 'FAIL build unexpectedly succeeded without bundle' >&2
    exit 1
fi
grep -q 'owner-set' "$tmp/build-override.err" && {
    echo 'FAIL FUNKOT_OWNER_PLAYER still hit owner-set re-register' >&2
    cat "$tmp/build-override.err" >&2
    exit 1
}

echo "android signed release plan: OK"

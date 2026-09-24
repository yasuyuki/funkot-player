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

echo "android signed release plan: OK"

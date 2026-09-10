#!/bin/sh
# Verify the sibling used by the path dependency before a player build.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
pin_file="$root/funkot-core.commit"
core=${FUNKOT_CORE_REPO:-"$root/../funkot-autodj-for-ui"}

die() {
    echo "FAIL: $*" >&2
    exit 1
}

[ -f "$pin_file" ] || die "missing tracked core commit: $pin_file"
[ -e "$core/.git" ] || die "missing core sibling: $core"

pin=$(tr -d '\r\n' < "$pin_file")
printf '%s' "$pin" | grep -Eq '^[0-9a-f]{40}$' ||
    die "funkot-core.commit must contain one lowercase 40-character SHA"

candidate=${FUNKOT_CORE_CANDIDATE_SHA:-}
if [ -n "$candidate" ]; then
    expected=$candidate
    mode=candidate
else
    expected=$pin
    mode=official
fi
printf '%s' "$expected" | grep -Eq '^[0-9a-f]{40}$' ||
    die "FUNKOT_CORE_CANDIDATE_SHA must be a lowercase 40-character SHA"

actual=$(git -C "$core" rev-parse HEAD) || die "cannot resolve core HEAD: $core"
[ -n "$(git -C "$core" status --porcelain)" ] &&
    die "core checkout is dirty; official and candidate builds require a clean commit"
[ "$(git -C "$core" cat-file -t "$expected" 2>/dev/null)" = commit ] ||
    die "$mode core SHA is not present as a commit in $core"
[ "$actual" = "$expected" ] || die "$mode core SHA is $actual, expected $expected"
printf 'funkot-core %s SHA: %s\n' "$mode" "$actual"

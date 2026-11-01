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
core_status=$(git -C "$core" status --porcelain) || die "cannot inspect core checkout: $core"
[ -n "$core_status" ] &&
    die "core checkout is dirty; official and candidate builds require a clean commit"
[ "$(git -C "$core" cat-file -t "$expected" 2>/dev/null)" = commit ] ||
    die "$mode core SHA is not present as a commit in $core"
[ "$actual" = "$expected" ] || die "$mode core SHA is $actual, expected $expected"
verify_dir=$(mktemp -d)
trap 'rm -f "$verify_dir/index" "$verify_dir/index.lock"; rmdir "$verify_dir"' EXIT
fresh_git() {
    GIT_INDEX_FILE="$verify_dir/index" git -C "$core" \
        -c core.splitIndex=false -c core.fsmonitor=false -c core.ignoreStat=false "$@"
}
fresh_git read-tree "$expected" || die "cannot read $mode core commit"
core_contents=$(fresh_git status --porcelain) || die "cannot verify core checkout contents"
[ -z "$core_contents" ] ||
    die "core checkout contents differ from $mode commit; cached file metadata is insufficient"
printf 'funkot-core %s SHA: %s\n' "$mode" "$actual"

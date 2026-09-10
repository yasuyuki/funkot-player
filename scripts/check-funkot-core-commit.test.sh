#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
player="$tmp/player"
core="$tmp/core"
mkdir -p "$player/scripts" "$core"
cp "$root/scripts/check-funkot-core-commit.sh" "$player/scripts/"

git -C "$core" init -q
git -C "$core" config user.email test@example.invalid
git -C "$core" config user.name test
touch "$core/core.rs"
git -C "$core" add core.rs
git -C "$core" commit -qm first
first=$(git -C "$core" rev-parse HEAD)
printf '%s\n' "$first" > "$player/funkot-core.commit"

run() {
    FUNKOT_CORE_REPO="$core" "$player/scripts/check-funkot-core-commit.sh" >/dev/null
}
must_fail() {
    if "$@" >/dev/null 2>&1; then
        echo "expected failure: $*" >&2
        exit 1
    fi
}

run
env FUNKOT_CORE_REPO="$core" FUNKOT_CORE_CANDIDATE_SHA= \
    "$player/scripts/check-funkot-core-commit.sh" >/dev/null

printf 'next\n' >> "$core/core.rs"
git -C "$core" add core.rs
git -C "$core" commit -qm second
second=$(git -C "$core" rev-parse HEAD)
must_fail run
FUNKOT_CORE_REPO="$core" FUNKOT_CORE_CANDIDATE_SHA="$second" \
    "$player/scripts/check-funkot-core-commit.sh" >/dev/null

printf 'dirty\n' >> "$core/core.rs"
must_fail env FUNKOT_CORE_REPO="$core" FUNKOT_CORE_CANDIDATE_SHA="$second" \
    "$player/scripts/check-funkot-core-commit.sh"
git -C "$core" checkout -- core.rs

printf '%040d\n' 0 > "$player/funkot-core.commit"
must_fail run
echo "core commit checks: OK"

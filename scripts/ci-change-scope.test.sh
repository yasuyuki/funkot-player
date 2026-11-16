#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
scope="$root/scripts/ci-change-scope.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

expect() {
    want=$1
    label=$2
    got=$(tr '\n' ' ')
    if [ "$got" != "$want " ]; then
        echo "$label: expected '$want', got '$got'" >&2
        exit 1
    fi
}
frontend='native=false cycle_reference=false'
native='native=true cycle_reference=false'
everything='native=true cycle_reference=true'

classified() {
    printf '%s\n' "$@" | "$scope" --classify
}
classified src/App.svelte tests/ui/queue-ui.spec.mjs docs/ui-design.md README.md | expect "$frontend" 'frontend and docs'
classified vite.config.ts index.html public/icon.svg | expect "$frontend" 'frontend configuration'
classified src/App.svelte src-tauri/src/lib.rs | expect "$native" 'player library'
classified src-tauri/tauri.conf.json | expect "$native" 'tauri configuration'
classified src-tauri/src/transport_fade.rs | expect "$everything" 'transport fade'
classified src-tauri/examples/diagnostic_cycle_reference.rs | expect "$everything" 'cycle reference example'
for file in funkot-core.commit src-tauri/Cargo.lock src-tauri/build.rs Dockerfile dev.sh package.json \
    package-lock.json .github/workflows/checks.yml scripts/ci-change-scope.sh verification/model.tla; do
    classified src/App.svelte "$file" | expect "$everything" "$file"
done
"$scope" --classify < /dev/null | expect "$frontend" 'no changed file'

repo="$tmp/repo"
git init -q "$repo"
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config user.name test
commit() {
    mkdir -p "$repo/$(dirname "$1")"
    echo "$2" > "$repo/$1"
    git -C "$repo" add "$1"
    git -C "$repo" commit -qm "$1"
}
commit src-tauri/src/lib.rs base
main=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" update-ref refs/remotes/origin/main "$main"
resolved() {
    (cd "$repo" && env -u GITHUB_OUTPUT "$@" "$scope" 2>/dev/null)
}
topic() {
    resolved GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/topic
}

commit src/App.svelte first
topic | expect "$frontend" 'frontend topic'
commit src-tauri/src/lib.rs changed
commit src/App.svelte second
topic | expect "$native" 'a later frontend push keeps the topic native'

before=$(git -C "$repo" rev-parse HEAD)
commit docs/note.md note
resolved GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main BEFORE="$before" | expect "$frontend" 'main push range'
resolved GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main BEFORE="$main" | expect "$native" 'main push of a merged topic'
resolved GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
    BEFORE=0000000000000000000000000000000000000000 | expect "$everything" 'main push without a previous commit'
resolved GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v1.0.0 | expect "$everything" 'tag push'
resolved GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=main | expect "$native" 'pull request'
resolved GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=absent | expect "$everything" 'pull request without its base'
resolved GITHUB_EVENT_NAME=workflow_dispatch | expect "$everything" 'other event'

out="$tmp/output"
(cd "$repo" && GITHUB_OUTPUT="$out" GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/topic "$scope" >/dev/null 2>&1)
expect "$native" 'step output' < "$out"

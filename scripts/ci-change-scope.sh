#!/bin/sh
# Decide which native checks a Checks run needs from the files its change touches.
#
#   native           false when every changed file is frontend or documentation,
#                    which the Rust build and tests do not read.
#   cycle_reference  true when the change can reach the diagnostic cycle reference
#                    example: the example, transport_fade.rs, the core pin or the
#                    build setup.
#
# A range that cannot be determined, and any file not listed here, selects everything.
set -eu

classify() {
    native=false
    cycle_reference=false
    while IFS= read -r path; do
        case $path in
            src/*|tests/*|docs/*|public/*|.claude/*|*.md|LICENSE|index.html) ;;
            vite.config.ts|svelte.config.js|tsconfig.json|playwright.config.mjs) ;;
            src-tauri/examples/*|src-tauri/src/transport_fade.rs)
                native=true
                cycle_reference=true ;;
            src-tauri/src/*|src-tauri/tests/*|src-tauri/capabilities/*|src-tauri/tauri.conf.json)
                native=true ;;
            *)
                native=true
                cycle_reference=true ;;
        esac
    done
    printf 'native=%s\ncycle_reference=%s\n' "$native" "$cycle_reference"
}

base() {
    default=origin/${DEFAULT_BRANCH:-main}
    case ${GITHUB_EVENT_NAME:-} in
        pull_request)
            git merge-base "origin/$GITHUB_BASE_REF" HEAD ;;
        push)
            case ${GITHUB_REF:-} in
                "refs/heads/${DEFAULT_BRANCH:-main}")
                    git rev-parse --verify --quiet "${BEFORE:-}^{commit}" ;;
                refs/heads/*)
                    git merge-base "$default" HEAD ;;
                *)
                    return 1 ;;
            esac ;;
        *)
            return 1 ;;
    esac
}

if [ "${1:-}" = --classify ]; then
    classify
    exit
fi

if from=$(base 2>/dev/null) && files=$(git diff --name-only "$from" HEAD 2>/dev/null); then
    echo "changed since $from:" >&2
    printf '%s\n' "$files" | sed 's/^/  /' >&2
    result=$(printf '%s\n' "$files" | sed '/^$/d' | classify)
else
    echo "change range unknown; selecting every check" >&2
    result=$(printf 'native=true\ncycle_reference=true\n')
fi
printf '%s\n' "$result"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s\n' "$result" >> "$GITHUB_OUTPUT"
fi

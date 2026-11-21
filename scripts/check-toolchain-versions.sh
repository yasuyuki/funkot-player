#!/bin/sh
# The Windows jobs in Checks install the versions in toolchain.versions.
# Fail when the normal Docker toolchain reports other versions, so Windows
# keeps testing what Docker builds.
set -eu
cd "$(dirname "$0")/.."

actual=$(./dev.sh sh -c 'printf "rust=%s\nnode=%s\nnpm=%s\n" "$(rustc --version | cut -d " " -f2)" "$(node -p process.versions.node)" "$(npm --version)"' | grep -E '^(rust|node|npm)=')
printf '%s\n' "$actual"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$actual" >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$actual" != "$(cat toolchain.versions)" ]; then
    echo "toolchain.versions does not match the Docker toolchain; set it to the versions above." >&2
    exit 1
fi

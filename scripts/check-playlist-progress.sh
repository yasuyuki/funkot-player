#!/usr/bin/env bash
# Local and Checks use this same bounded verification, after tool preparation.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=funkot-player-kani:0.68.0
if [[ ${1:-} == --setup ]]; then
    exec docker build -t "$image" -f "$root/verification/Dockerfile" "$root/verification"
fi
if (( $# > 1 )); then echo "usage: $0 [--setup | evidence-directory]" >&2; exit 2; fi
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/playlist-progress.XXXXXXXX")}
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
echo "Evidence: $out"
docker run --rm --memory=8g --memory-swap=8g \
    -v "$root:/work:ro" -v "$out:/results" "$image" \
    python3 verification/check.py

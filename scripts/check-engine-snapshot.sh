#!/usr/bin/env bash
# Same image as the playlist Kani check. Without that image, Rust 1.93 on the host runs the same cargo test.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=funkot-player-kani:0.68.0
if [[ ${1:-} == --setup ]]; then
    exec "$root/scripts/check-playlist-progress.sh" --setup
fi
if (( $# > 1 )); then echo "usage: $0 [--setup | evidence-directory]" >&2; exit 2; fi
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/engine-snapshot.XXXXXXXX")}
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
echo "Evidence: $out"
unset ENGINE_OBSERVATION_RS ENGINE_OBSERVATION_ALLOW_SUBSTITUTE
if command -v docker >/dev/null 2>&1 && docker image inspect "$image" >/dev/null 2>&1; then
    docker run --rm --memory=8g --memory-swap=8g \
        -e FUNKOT_SNAPSHOT_RUNNER=image \
        -v "$root:/work:ro" -v "$out:/results" -w /work "$image" \
        python3 verification/engine_snapshot/check.py /results
else
    if command -v docker >/dev/null 2>&1; then
        echo "missing $image; run $0 --setup" >&2
        exit 2
    fi
    echo "docker is absent; using host Rust 1.93" >&2
    FUNKOT_SNAPSHOT_RUNNER=host python3 "$root/verification/engine_snapshot/check.py" "$out"
fi

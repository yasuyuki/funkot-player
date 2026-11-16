#!/usr/bin/env bash
# Exhaustive check that the device never receives a sample outside [-1, 1]. Needs Rust 1.93 only.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if (( $# > 1 )); then echo "usage: $0 [evidence-directory]" >&2; exit 2; fi
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/output-guard.XXXXXXXX")}
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
echo "Evidence: $out"
unset OUTPUT_GUARD_RS OUTPUT_GUARD_ALLOW_SUBSTITUTE
exec python3 "$root/verification/output_guard/check.py" "$out"

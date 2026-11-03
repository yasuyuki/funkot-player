---
name: verify-playback-recovery
description: >-
  Verify the Kani proof when changing legacy normal-source selection, missing
  current-identity restoration, their playback-state call sites, or this proof.
---

# Playback recovery proof

This proof guards legacy normal-queue recovery. A broken decision can replace a
durable current identity or silently select one of two divergent saved queues.

## Coverage record

`sync_commit` is `c702f87024049cf65d9aa5baddac552056669b33`.

`source_sha256` is
`5665267d99787f396f81fde8022ee4935c63d5ee2c16f542a1475e413033d3b8` for
`src-tauri/src/playback_recovery.rs` at that commit.

`playback_state_sha256` is
`821f06bc47955de7f22ae0d3f7718b684853743b683ee4c49854174c0463692f` for
`src-tauri/src/playback_state.rs` at that commit.

Production `playback_state.rs` calls `classify_legacy_normal` while reading
legacy files. It calls `restore_missing_current_identity` before validating the
snapshot. `verification/playback_recovery.rs` imports that production module
directly. `verification/check.py` requires both harnesses and their five
reachable covers each.

Read [bounds.md](bounds.md) before treating a pass as complete recovery
coverage.

## Run

On Linux x86_64 with Docker and cgroup v2, from the player root, use the
existing Kani image and runner:

```sh
./scripts/check-playlist-progress.sh /tmp/playback-recovery-proof
```

Pass means `summary.json` reports `"status": "PASS"`, includes
`proofs::classifies_legacy_normal_import` and
`proofs::restores_missing_normal_current_identity`, and records both recovery
sensitivity checks, `playback_recovery_identity` and
`playback_recovery_classifier`, as `EXPECTED_FAIL`. The runner fixes Kani at
0.68.0, keeps the existing timeout and memory limits, and rejects missing or
unreachable covers.

## Failure

A failed assertion from `classifies_legacy_normal_import` is a recovery bug
when present unequal sources do not return `Conflict`, or when an absent or
equal source pair selects the wrong import.

A failed assertion from `restores_missing_normal_current_identity` is a
recovery bug when an existing or playlist current changes, when a missing
normal current ignores its first matching identity, or when creation happens
other than once.

A temporary-copy sensitivity result that fails to compile, times out, or passes
means the proof no longer detects the regression it claims to guard. Fix the
driver or property before accepting the proof. A Kani tool, JSON, or cover
failure is not a product counterexample. Repair the runner or report the
verification as blocked.

## Intended changes

Re-read the production calls and the direct-import driver. If the two decisions
and their mappings still match [bounds.md](bounds.md), run the command above.
Move `sync_commit`, `source_sha256`, and `playback_state_sha256` only after that
run passes for the commit being recorded. If callers add behavior outside these
decisions, extend the proof or leave that behavior with the native recovery tests. Use
`/maintain-formal-verification-skill` when later code changes need this proof
brought back in sync.

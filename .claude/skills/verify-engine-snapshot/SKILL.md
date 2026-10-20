---
name: verify-engine-snapshot
description: >-
  Proves a funkot-player engine snapshot read returns one completed
  (current, finished) publication or nothing. Use when changing
  EngineObservation, publish_engine_observation, the audio callback's
  observation.publish, playlist reconcile_snapshot, or queue retirement
  that trusts EngineSnapshot.
---

# Engine snapshot coherence

A reader of `EngineObservation` gets `None` or one completed pair of `current` and `finished`. A torn pair lets playlist consumption and queue retirement treat an old index as finished.

Keep the existing Kani harness names, unwind bounds, and cover counts in `verification/check.py`. This check compiles `src-tauri/src/engine_observation.rs` and leaves that file unchanged.

## When it applies

Search the player diff for `EngineObservation`, `publish_engine_observation`, `observation.publish`, `reconcile_snapshot`, `observe_started`, or `mark_started`.

No match means this check does not apply. A match means run it before finishing the change.

## Run

From the `funkot-player` root, on Linux x86_64:

```sh
./scripts/check-engine-snapshot.sh /tmp/engine-snapshot-proof
```

`--setup` builds the existing image `funkot-player-kani:0.68.0` when Docker is available. Without Docker, the script runs the package with Rust 1.93. Loom 0.7.2 is pinned in `verification/engine_snapshot/Cargo.toml`.

Done when `summary.json` has `"status": "PASS"`, `source` ends with `src-tauri/src/engine_observation.rs`, and `source_sha256` matches that file. Exit 0 is that result. Docker without the image exits 2. Read [bounds.md](bounds.md) before treating a pass as the whole player.

## Failure

Replay the panic's `EngineSnapshot` against `publish` and `read`.

The returned pair equals neither the value before `publish` nor the value `publish` wrote. That is a bug in `engine_observation.rs`. Report the pair and the harm. Leave the module unchanged.

The trace names an atomic operation the production function does not call, or `build.rs` rejects the import. That is a modeling error. Point the proof back at the production function and rerun.

`summary.json` says the proof compiled a different file. Rerun the official script with `ENGINE_OBSERVATION_RS` unset.

## After an intended change

1. Re-read `publish`, `read`, and every production caller in [bounds.md](bounds.md). Completion: each caller still publishes only while holding the render mutex, or the single-writer assumption is false and this check is blocked.
2. Rerun the script. Completion: `PASS`, or a bug report from the failure section.
3. If the proof or `build.rs` changed, copy `engine_observation.rs` to a temp file and replace `(before == after)` with `(before % 2 == 0)` in `read_after_before`. Run the command below. Completion: `index_and_finished_move_together`, `absent_current_hides_the_stale_index`, and `reader_can_span_two_serialized_publishes` fail, and `quiescent_publish_is_exactly_the_written_pair` passes. Delete the copy.

```sh
ENGINE_OBSERVATION_RS="$copy" ENGINE_OBSERVATION_ALLOW_SUBSTITUTE=1 \
  cargo +1.93.0 test --locked --manifest-path verification/engine_snapshot/Cargo.toml -- --test-threads=1
```

4. Rerun the official script. Completion: `PASS`, and `git diff -- src-tauri/src/engine_observation.rs` is empty.
5. Move `sync_commit` in [bounds.md](bounds.md) to the commit you checked. Do that only after steps 1 and 2 describe that commit. Leave it when the check is blocked or failing.

`/maintain-formal-verification-skill` covers edits that skipped this skill.

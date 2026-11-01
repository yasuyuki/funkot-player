---
name: verify-engine-snapshot
description: >-
  Proves a funkot-player engine snapshot read returns one completed
  (current, finished) publication or nothing. Use when a change touches
  src-tauri/src/engine_observation.rs, a publish of that observation, or
  verification/engine_snapshot, including a condition-only edit, a rename,
  or a new caller. A diff that lacks the old symbol names still requires
  this check.
---

# Engine snapshot coherence

A reader of `EngineObservation` gets `None` or one completed pair of `current` and `finished`. A torn pair lets playlist consumption and queue retirement treat an old index as finished.

Keep the existing Kani harness names, unwind bounds, and cover counts in `verification/check.py`. This check compiles `src-tauri/src/engine_observation.rs` and leaves that file unchanged.

## Sync record

`sync_commit` names the last commit whose proof meaning was checked. `source_sha256` in the official script's `summary.json` names the bytes that run compiled. A new hash in `summary.json` leaves `bounds.md` unchanged.

The proof meaning is the same when three facts stay true. `publish` and `read` keep the same atomic steps, in the same order, under the same conditions. Every production caller still publishes only while it holds the render mutex, and `WRITER_COUNTS` still names that set. The property in `bounds.md` still describes that behavior.

A comment or a formatting edit keeps those three facts. The outcome is `in sync`. Leave `.claude/skills/verify-engine-snapshot/` and `verification/engine_snapshot/` as they are. Run the official script on the current source. Completion is `summary.json` status `PASS`, `source` ending in `src-tauri/src/engine_observation.rs`, and an empty `git diff` for those two directories.

An intentional change to a `publish` or `read` step is `updated`. Write the new steps into `bounds.md`, rerun the official script to `PASS`, and move `sync_commit` to the commit those steps describe.

A caller that publishes without the render mutex makes the single-writer assumption false. The outcome is `bug` or `blocked`. Leave the property, `WRITER_COUNTS`, and `sync_commit` as they are. A `PASS` from the official script is a result about `engine_observation.rs`. It is not a proof of that caller.

`/maintain-formal-verification-skill` tells the maintainer to set `sync_commit` to the commit just checked. For this check, that move is the `updated` case above. When the two instructions disagree, follow this section.

## CI and the agent

The Checks job `Engine snapshot coherence` runs `./scripts/check-engine-snapshot.sh` on the pushed commit. A green job means `summary.json` is `PASS` for that commit. It means the four named tests ran and passed, the compiled file is `src-tauri/src/engine_observation.rs`, and the writer set matches `WRITER_COUNTS` in `verification/engine_snapshot/check.py`. It does not re-read a lock edit that leaves those counts unchanged. A green job is not a reason to skip the steps below.

Before committing, from the `funkot-player` root:

```sh
python3 verification/engine_snapshot/check.py --applies
```

If the change is already committed, add `--base <parent>`.

Exit 0 means run the official script before finishing. When the JSON field `assumption_review` is true, re-read every writer and its mutex before accepting the single-writer assumption or editing `WRITER_COUNTS`. Exit 3 means this diff does not require a local run. Exit 3 is not a passing proof. Any other exit is not "verification not required".

`--applies` uses paths and call sites. These diffs require a run:

- any change to `src-tauri/src/engine_observation.rs`, including a condition that does not mention `EngineObservation` or `publish`
- a rename or delete of that file
- an added, removed, or edited `publish_engine_observation(` or `observation.publish(`
- an edit inside the span from the nearest lock within 200 lines above a publish through that publish, using the file text before the edit as well as after it
- a rename, copy, or delete of a path in `WRITER_COUNTS`, even when the call text is unchanged
- a change under `verification/engine_snapshot/`, `scripts/check-engine-snapshot.sh`, or this skill

An unrelated UI file does not require a run. `python3 verification/engine_snapshot/check.py --self-test` checks these examples. The official script runs that self-test before Loom, and a self-test failure is a `FAIL`.

## Run

From the `funkot-player` root, on Linux x86_64:

```sh
./scripts/check-engine-snapshot.sh /tmp/engine-snapshot-proof
```

`--setup` builds the existing image `funkot-player-kani:0.68.0` when Docker is available. Without Docker, the script runs the package with Rust 1.93. Loom 0.7.2 is pinned in `verification/engine_snapshot/Cargo.toml`.

Done when `summary.json` has `"status": "PASS"`, `source` ends with `src-tauri/src/engine_observation.rs`, and `source_sha256` matches that file. `PASS` means each name in the `TESTS` list ran once with `ok`, and the lib-test summary has no failures, ignores, or filtered tests. A Cargo exit code of 0 is not that result. Docker without the image exits 2. Read [bounds.md](bounds.md) before treating a pass as the whole player.

## Failure

Replay the panic's `EngineSnapshot` against `publish` and `read`.

The returned pair equals neither the value before `publish` nor the value `publish` wrote. That is a bug in `engine_observation.rs`. Report the pair and the harm. Leave the module unchanged.

The trace names an atomic operation the production function does not call, or `build.rs` rejects the import. That is a modeling error. Point the proof back at the production function and rerun.

`summary.json` says the proof compiled a different file. Rerun the official script with `ENGINE_OBSERVATION_RS` unset.

## After an intended change

1. Re-read `publish`, `read`, and every production caller in [bounds.md](bounds.md). Completion: each caller still publishes only while holding the render mutex, or the single-writer assumption is false and this check is blocked. A new or removed `publish_engine_observation(` or `observation.publish(` makes the official script `FAIL` until that read is done and `WRITER_COUNTS` is updated. Do not treat that `FAIL` as a passing proof, and do not change the count only to make the script exit 0.
2. Rerun the script. Completion: `PASS`, or a bug report from the failure section. `PASS` is the summary status, not a Cargo exit code.
3. If the proof or `build.rs` changed, copy `engine_observation.rs` to a temp file and replace `(before == after)` with `(before % 2 == 0)` in `read_after_before`. Run the command below. Completion: `index_and_finished_move_together`, `absent_current_hides_the_stale_index`, and `reader_can_span_two_serialized_publishes` fail, and `quiescent_publish_is_exactly_the_written_pair` passes. Delete the copy.

```sh
ENGINE_OBSERVATION_RS="$copy" ENGINE_OBSERVATION_ALLOW_SUBSTITUTE=1 \
  cargo +1.93.0 test --locked --manifest-path verification/engine_snapshot/Cargo.toml -- --test-threads=1
```

4. Rerun the official script. Completion: `PASS`, and `git diff -- src-tauri/src/engine_observation.rs` is empty.
5. If `check.py` or the test list changed, copy `verification/engine_snapshot` and the four writer files named by `WRITER_COUNTS` to a temp tree, delete one `#[test]` from the copy, and run that copy's `check.py`. Completion: the copy's summary is `FAIL` and names the missing test, even when Cargo's exit code would be 0. Delete the temp tree. Do not point the official script at the copy.
6. Apply the Sync record section. Its completion lines are the completion of this step.

`/maintain-formal-verification-skill` covers edits that skipped this skill.

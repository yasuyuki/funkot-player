# Bounds and existing proofs

## Sync

`sync_commit` is `2d9a5f7bb46e97fb0e26b9a2c4006b1fda417963`.

`src-tauri/src/engine_observation.rs` blob is `110c9df1085c3b8639ef87461bc83590b32201b9`.

The proof was run against that blob with `rustc 1.93.0 (254b59607 2026-01-19)` and Loom 0.7.2. The official script returned `PASS`. A copy that drops the `before == after` recheck made the three concurrent tests fail. The restored production file passed again. The script's `source_sha256` for that blob is `44546ac5dd779cdb8ba7a31d8e7715eee4ee2db69f9a9471ab7c643bb8094167`.

Move `sync_commit` only by the rule in `SKILL.md`.

## Property

`EngineObservation::read` returns `None`, the snapshot from the last completed `publish` visible to that read, or the snapshot `new` stored before that `publish`. It does not return `current` from one publication and `finished` from another.

`publish` is one writer function. Its indivisible steps are the `SeqCst` operations in order: increment `sequence`, store `current_present`, store `current` only when the index is `Some`, store `finished`, increment `sequence`. `read` loads `sequence`, returns `None` on an odd value, loads the three fields, loads `sequence` again, and returns the pair only when the two sequence values match.

## What the tests quantify

Loom's default preemption bound is unlimited. `max_branches` stays at Loom's default of 1_000, which is above the atomic steps in these tests.

- `index_and_finished_move_together`: one reader overlaps one publish from `(Some(1), false)` to `(Some(2), true)`.
- `absent_current_hides_the_stale_index`: one reader overlaps one publish from `(Some(1), false)` to `(None, true)`, the path that skips the `current` store.
- `reader_can_span_two_serialized_publishes`: one reader overlaps two publishes on the same writer thread, `(Some(1), false)` then `(None, true)` then `(Some(2), false)`.
- `quiescent_publish_is_exactly_the_written_pair`: after `publish` returns, `read` returns that pair, including `usize::MAX` and a later `None` current.

These concrete indexes stand for absent, one stored index, and a different stored index. An `AtomicUsize` load returns a whole stored word. The tests do not explore a `u64` sequence wrap.

## Single writer

Production `publish` runs while the render mutex is held. Callers at the sync commit:

- `Playback::publish_engine_observation` and `resume_finished_engine` in `src-tauri/src/lib.rs`
- the main-engine publish in `open_output_stream`, after `render.try_lock`, and only when this buffer is not auditioning
- `publish_engine_observation` in `src-tauri/src/playlist_service.rs` on the source-replacement and save-failure paths, each after `playback.render.lock`

A new caller that publishes without that mutex makes this proof blocked. Two overlapping writers are outside the model.

## Tool

Kani 0.68 compiles concurrent code as sequential code, and its own documentation says atomic proofs must not be trusted. A sequential Kani run of `publish` then `read` still passes after the sequence recheck is removed, so it cannot guard this property.

TLA+ can check a seqlock model. It does not compile `engine_observation.rs`, so deleting the recheck in Rust would not fail TLC.

Loom runs `publish` and `read`. `build.rs` rewrites only the atomic import to `loom::sync::atomic` and drops the module's unit tests. Any other atomic operation fails the build. The official script refuses `ENGINE_OBSERVATION_RS`.

## Already proved elsewhere

`verification/check.py` and `verification/README.md` own the Kani proofs. Their harnesses and cover counts:

- `proofs::occurrence_update` cover count 8, unwind 8
- `proofs::initial_and_seven_occurrences` cover count 2, unwind 8
- `proofs::membership_update` cover count 10
- `proofs::distinct_occurrences` cover count 2
- `proofs::automatic_fill_requires_exhausted_selection` cover count 3

Those proofs quantify the pure playlist and queue transitions. They assume the observation they receive is one real engine state. This check is that assumption for the published pair. It does not prove `NowTracker`, `observe_started`, catalog edits, or that `Engine::current_index` and `Engine::is_finished` are the audible track.

The next unverified boundary in this area is `PlaylistOwner::observe_started`: a lagging `TrackStarted` may consume its own occurrence, and the newer snapshot decides `current_index`.

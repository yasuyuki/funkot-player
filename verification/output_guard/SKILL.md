---
name: verify-output-guard
description: >-
  Proves that every sample funkot-player hands to the output device is finite
  and within [-1.0, 1.0]. Use when a change touches
  src-tauri/src/output_guard.rs, any build_output_stream call, code that
  writes the device buffer after the engine renders, or
  verification/output_guard. A new audio output path requires this check even
  when the diff never names the guard.
---

# Output sample bound

Every sample left in the device buffer is finite and within `[-1.0, 1.0]`. A sample outside that range is flattened or limited by the platform, differently on each one, and is heard as distortion. [#143](https://github.com/yasuyuki/funkot-player/issues/143) measured peaks near 2.0 before this guard existed.

The engine does not provide this bound. RMS normalization can raise a quiet track by 12 dB, a transition adds two decks, and the high-pass filter and the time stretch can overshoot. The player provides it in one place, `output_guard::guarded`, which wraps the stream callback.

## What is covered

| Code | What the check establishes |
|---|---|
| `seal` in `src-tauri/src/output_guard.rs` | For all 2^32 `f32` values: the result is within `[-1.0, 1.0]`, an in-range sample comes back bit for bit, an over becomes `1.0` or `-1.0`, and NaN becomes `0.0`. |
| `guarded` and `Limiter::process` in the same file | For all 2^32 values in either channel, beside eight kinds of neighbour, with the limiter's gain carried between buffers: the callback leaves only samples within `[-1.0, 1.0]`. |
| every `.build_output_stream(` under `src-tauri` | Its callback argument is `output_guard::guarded(`. The count of streams equals the count of wrapped streams, and at least one exists. |

`sync_commit` is `53cf6f9fdcf1fbca6cd4a913b45b691b3aa06f9f`. The `src-tauri/src/output_guard.rs` blob at that commit is `a5e4d61b08918269cf030ca1cc136e17818bea71`.

## Run

From the `funkot-player` root, with `cargo +1.93.0` available. Docker is not used.

```sh
./scripts/check-output-guard.sh /tmp/output-guard-proof
```

Done when the printed summary has `"status": "PASS"`. The run takes a few seconds on a multi-core host. `PASS` means both names in `TESTS` ran once with `ok`, the compiled file is the production guard, and every stream is wrapped. A Cargo exit code of 0 is not that result. The Checks job `Output sample bound` runs the same script on each pushed commit.

## Failure

`seal(0x…) = 0x…, expected 0x…` names an input bit pattern and both results. `seal` returns the wrong value for that input. That is a bug in `output_guard.rs`.

`callback left <value> for input 0x… beside <partner>` means `guarded` wrote a sample after `seal`, or stopped calling it. Read `guarded`: the loop that calls `seal` must be its last statement, after `fill` and `limiter.process`.

`N device stream(s), M wrapped in output_guard::guarded` means a stream's callback reaches the device without the guard. Wrap the callback. Do not edit the regular expressions in `check.py` to match an unwrapped call.

`the proof did not compile the production guard` means `OUTPUT_GUARD_RS` leaked into the run. Use the official script, which unsets it.

A failure is a modeling error only when `check.py` or `src/lib.rs` no longer describes the code, for example after `guarded` is renamed. Then update the check to the new name and rerun. Never widen the expected range or drop a test to obtain `PASS`.

## After an intended change

1. Re-read `guarded`. Completion: `seal` is still applied to every element of `out` after every other write.
2. If audio now reaches a device by another route (a second stream, another audio API, a sample format other than `f32`), route it through `guarded` first. A route the regular expression in `check.py` cannot see is outside this check until `streams()` is extended to count it.
3. Run the script. Completion: `PASS`.
4. If `output_guard.rs`, `src/lib.rs`, `build.rs` or `check.py` changed, show that the check can still fail. Copy `src-tauri/src/output_guard.rs` to a temporary file, delete the three-line `for sample in out.iter_mut()` loop from `guarded` in the copy, and run:

   ```sh
   OUTPUT_GUARD_RS="$copy" OUTPUT_GUARD_ALLOW_SUBSTITUTE=1 CARGO_TARGET_DIR="$(mktemp -d)" \
     cargo +1.93.0 test --locked --manifest-path verification/output_guard/Cargo.toml
   ```

   Completion: `the_wrapped_callback_leaves_only_full_scale_samples_for_every_f32` fails with `callback left 1.0000001`. Then change `sample > 1.0 { 1.0` to return `sample` in a fresh copy. Completion: both tests fail. Delete the copies and rerun the official script to `PASS`.
5. Move `sync_commit` and the blob above to the checked commit. Do that only when the `output_guard.rs` blob changed and steps 1 to 3 describe that commit.

## Not covered

- **How it sounds.** `Limiter` lowers both channels at once when a frame exceeds full scale and returns to unity gain over about a second. Its attack is instant, so the first over of a burst is reshaped. The unit tests in `output_guard.rs` cover its behaviour; whether an over is audible needs listening.
- **The engine's level.** The check says nothing about how often the limiter acts. A track that RMS normalization raises above full scale is ridden down continuously.
- **After the device buffer.** The platform's mixer, volume and effects are outside the app.
- **The diagnostic reference.** `src-tauri/examples/diagnostic_cycle_reference.rs` renders the engine and the transport fade without this guard. Its output differs from the device's where the engine exceeds full scale.
- **Other callers of the engine.** The CLI and WAV rendering in the engine repository do not pass through the player's guard.

`/maintain-formal-verification-skill` covers edits that skipped this skill.

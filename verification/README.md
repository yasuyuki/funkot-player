# Playlist occurrence progress

This check addresses [player #44's consumption contract](https://github.com/yasuyuki/funkot-player/issues/44#issuecomment-5841328990).
It directly imports `src-tauri/src/playlist_progress.rs`. Production
`Catalog::observe_progress` and the standalone driver call the same `observe`
function. No Kani branch substitutes the transition and no verifier dependency
enters Cargo or the Android APK.

## Run

Linux x86_64, Docker and cgroup v2 are required. From the player root:

```sh
./scripts/check-playlist-progress.sh --setup
./scripts/check-playlist-progress.sh /tmp/playlist-proof
```

Preparation builds a reusable image with Kani **0.68.0**, bundled Rust
**nightly-2026-08-21** (`1.100.0-nightly 8925ea358 2026-08-20`), CBMC **6.11.0**.
The Docker base's Rust 1.93 only builds the verifier launcher. The independent
Checks job caches this image and runs the same script; it needs no core sibling,
Android SDK, native build or UI. Evidence includes `kani.log`, `kani.json`, and
`summary.json` (wall time and cgroup peak memory). Verification has a total
15-minute deadline and 8-GiB container memory limit with no additional swap.
Unwinding, overflow, pointer and other default Kani assertions remain enabled.
Timeout, solver/unsupported reachability failure, absent harnesses or unreached
covers fail the check. Kani can warn about unsupported *unreachable* panic
machinery; reaching it must still fail verification.

## Property and scope

For any catalog occurrence and any progress state, a newly consumed
occurrence must have an accepted observation of the same playlist/run/entry and
engine index, or a reasoned unavailable/failed observation. Repeats are
idempotent; invalid observations leave progress unchanged. Valid observations
must progress, so replacing the implementation with a no-op fails.

- `occurrence_update` quantifies arbitrary before-state, optional registered
  target, optional engine claim and start/current/failure/unavailable/passive
  input. Run IDs are unrestricted `u64`, indices unrestricted `usize`, liveness
  and cancellation independent. There are no `kani::assume` restrictions on
  state or event order, including imported/restored failure flags.
- `initial_and_seven_occurrences` checks the empty initial state and independent
  updates to five occurrences plus another playlist's two. An observation can
  add at most one occurrence. This is a bounded non-interference check, not a
  seven-entry limit on the product. Both harnesses use unwind 8; unwinding
  assertions check that bound.
- Playlist and entry strings are represented by arbitrary `u8` equality IDs.
  The transition only uses equality, never arithmetic or string properties.
  The abstraction retains equal/different/absent/cancelled/old-run relations.
  Each invocation compares at most a target, claim and unavailable identity;
  256 distinct values are more than required to represent all such relations.
  The seven-entry case uses unique entry IDs, as required by `Catalog::validate`.
  Paths are deliberately absent: repeated A paths do not share entry IDs.
- Delayed starts of retired claims are valid; cancelled future claims are not.
  Source generation, loader epoch, run ID and engine index are separate in the
  production service. A source switch can preserve an old-source audible
  current. Generation is not used to reject it. The production integration
  tests exercise this mapping, preparation/lookahead, source switches, stale
  runs, restarts and failures.

The one-update consumption property holds for every input progress state.
Repeated serialized progress updates therefore preserve it regardless of
event/snapshot order. This is not an arbitrary-length
proof of every catalog edit: restart/resume can remove consumed membership, and
undo restores a removed occurrence's historical consumed/failure evidence only
within its original run. Existing Rust tests cover those operations.

## Production boundaries

The service's index-keyed claim map binds the exact occurrence returned by
`ManagedSource::next`; preparation alone changes no catalog progress. The
catalog adapter resolves membership/current run with ordinary collection lookups
and derives `reason_present` from a real, retained, nonblank reason. `observe`
checks the resulting identity against the claim and index and computes the
progress. The adapter and source cancellation/epoch behavior are covered by
normal Rust tests, not by a proof of the collection implementation.

Both the non-audition `TrackStarted` route and the authoritative
`Engine::current_index` snapshot route use this transition. Loader/gate failures
also use it. Finished/exhausted, pending-empty, in-flight-empty and lifecycle
notifications do not create start evidence; the driver's passive input models
that absence of a progress update. A service call can apply a delayed event and
then a newer snapshot: these are two separately justified observations.

Real Engine integration tests connect emitted events/current snapshots to saved
progress and preserve other occurrences. The verifier trusts the meaning of an
Engine start/current observation. An incorrect producer can still lead to a
consumption that passes this proof. Threads, mutex ordering, Android lifecycle,
audio focus/output, DSP/clicks, and crash-safe file writes are outside this proof.
A proof PASS does not resolve the device failures or close #44.

For sensitivity checking, copy this driver and production module into an isolated
temporary tree and change `Observation::Passive => None` to
`Observation::Passive => Some(Cause::Started)`. Running the same entry must fail;
discard that temporary tree's mutation and rerun the unchanged production source.
This synthetic mutation is not evidence of the device failure's cause.

---
name: verify-transport-phase
description: >-
  Model-check Funkot Player's transport phase (idle, starting, playing,
  paused, stalled, failed, disconnected) with TLC after any change to a
  set_phase call or PHASE write, Phase, record_pause_change, flip_paused, set_paused,
  playback_session_alive, start_impl, audio_thread, the audio callback in
  open_output_stream, or verification/transport_phase. Also use it to redraw
  the transport phase statechart.
---
# Verify the transport phase

`PHASE` in `src-tauri/src/lib.rs` is written by four threads with no single
owner: `start_impl`, `audio_thread` (setup, first open, the watchdog loop),
the cpal audio callback in `open_output_stream`, and the pause/play commands
(`toggle_pause` and `onNativeControl` actions 0, 4 and 5, through
`flip_paused`, `set_paused` and `record_pause_change`). The UI
(`transportMode.ts`) and Android's `playbackAlive` read it.

## Rules

- `FailedStaysFailed`: once the audio thread gives up, the screen keeps showing
  `failed`. Harm when broken: the failure and its log link disappear, and a
  pause/resume button comes back that plays nothing.
- `AliveMatchesAudioThread`: `playback_session_alive` is true exactly while the
  audio thread is running or about to run. Harm when broken: an Android
  notification keeps offering transport controls with nothing behind them.

## The pause write (#162)

`record_pause_change` writes Paused with one `PHASE.fetch_update` that leaves
Disconnected and Failed in place (`PauseWrite = "atomic"`). Before #162 it
loaded the phase and then stored Paused unless the phase was Disconnected. A
pause after the first `open_output_stream` failed then replaced Failed with
Paused, and `playback_session_alive(true, Paused)` returned true.

The runner keeps two broken writes as variants that must still fail:
`current` (the code before #162) breaks both rules, and `checked` (load, skip
Failed too, then store) still breaks `FailedStaysFailed`, because the first open
can fail between the load and the store. Do not split the write back into a
load and a store.

## When to use

Run when a diff touches any name in the description, adds or removes a
`set_phase(` call or another `PHASE.` write (store, swap, `fetch_*`,
`compare_exchange*`) outside `#[cfg(test)]` modules, or changes what
`playback_session_alive` returns. Line moves alone do not need a run: model
references are scoped by function name, not line number.

Sync commit: `d02c86b962070c156cb165959f754427f706928c`. To see what changed since:

```sh
git diff d02c86b962070c156cb165959f754427f706928c -- src-tauri/src/lib.rs
```

Read every hunk inside the functions named above. Move the sync commit forward
only after you confirm each model action and its `lib.rs:FN | FRAGMENT`
comment in `verification/transport_phase/TransportPhase.tla` still describes
the code at the new commit.

## Run

From the player root on Linux, Python 3.12+ and Java 21, on a clean committed
checkout (the runner archives `HEAD`):

```sh
python3 -B -m unittest discover -s verification -p 'test_transport_phase.py'
python3 -B verification/check_source_switch.py --setup
python3 -B verification/check_transport_phase.py --output "$(mktemp -d)/transport-phase-proof"
```

`--setup` downloads the pinned TLC 1.7.4 jar into `~/.cache/funkot-verification`.
Pass `--jar` and `--java` when they live elsewhere. The run takes a few seconds.
CI runs it in the `Source switch model` job and uploads `transport-phase-proof`.

Read `summary.json`:

- `PASS`: `FINDINGS` is empty, every rule holds over the whole graph, and each
  broken variant in `VARIANTS` still fails its rule.
- `KNOWN_FINDINGS`: only while `FINDINGS` lists rules the code breaks; each
  still breaks and every other rule holds.
- `FAIL` with `error`: read the message. Never report it as a pass.

`summary.json` also records the revision, source hashes, state counts, and
`phase_writers` (the `set_phase` call count per function).

## Read a failure

Read every TLC log (`<rule>.log` and `<variant>.log`) with the
`/statechart` skill and `verification/transport_phase/view.mjs`. It tells each
violation as its shortest path in plain words.

- `expects fn X to contain ...` or `no longer defines`: the cited code changed.
  Read the function. Moved text with the same behavior needs only the fragment
  updated. Changed behavior needs the action updated first.
- `set_phase writers changed`: a write to PHASE (`set_phase(` or a direct
  atomic write) was added, removed or moved to another function. Model it as its own action (one atomic store per action),
  then update `PHASE_WRITERS`. Do not edit the count alone.
- `missing the required checked counterexample` on a variant in `VARIANTS`:
  a broken pause write no longer breaks its rule, so the model or a rule
  changed. Find which change did that before trusting a `PASS`.
- `TLC did not finish the complete safety check` on a rule not in `FINDINGS`:
  a new break. Replay the path against the code, one step per action, as a
  unit test or a live run. If the code takes those steps, report a product bug
  with the path. If it cannot, the model drifted: fix the action that differs.
  Do not weaken a rule, and do not add a finding to make the run green.

## Update for an intended change

Change the code, then the matching action, its `lib.rs:FN | FRAGMENT` comment,
`SOURCE_REFERENCE_COUNT` and `PHASE_WRITERS` in `verification/check_transport_phase.py`,
in the same commit. An action is one atomic load, store, swap or fetch_xor, or
one section under the render mutex; split a two-step read-then-write into two
actions. Rerun, read the result with `/statechart`, and move the sync commit.

If the change alters the chart, redraw it with `/statechart` using
`verification/transport_phase/Chart.cfg` (no presses, so the whole graph fits the
chart budget) and the view, and replace `verification/transport_phase/chart.mmd`.
`TransportPhase.cfg` exceeds the chart budget, so on it `/statechart` draws only
bug paths.

## Scope

Bounds: one start, at most three pause/play presses (toggle, set pause, set
play, in any mix), at most one output-device loss and return, both initial pause
states, and every interleaving of the four threads. Silence, the engine
running out of tracks, and long silence are free choices at each callback.

Left out: audition (see `verify-audition`; pause is refused while
`AUDITIONING` or `AUDITION_PREPARING`), skip and the manual-Next wait thread,
persistence of the pause flag, the UI poll, Kotlin's notification code beyond
`playbackAlive`, transport fades (they do not change the stored phase), and the
render-lock miss (the callback then stores nothing). The chart shows that a
callback in flight can store Playing after the watchdog stored Disconnected;
the next watchdog tick restores Disconnected within one second. No rule
covers that window.

The model is written by hand. The source and writer checks catch renamed or
moved code and new `set_phase` calls, but not a changed meaning inside a
cited function, so keep the action audit above.
